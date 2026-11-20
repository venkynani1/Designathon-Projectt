-- =====================================================================
-- 1) "Said No but came": recorded when they scan / are looked up at the desk.
-- 2) Offline registrations import (Employee ID, Name, Veg/Non-veg, Goodie).
-- =====================================================================
alter table goodie_declines add column if not exists attended_at     timestamptz;
alter table goodie_declines add column if not exists acknowledged_at timestamptz;
alter table goodie_declines add column if not exists acknowledged_by text;

alter table goodie_choices drop constraint if exists goodie_choices_via_check;
alter table goodie_choices add constraint goodie_choices_via_check check (via in ('survey', 'autopick', 'offline'));

create or replace function dx_collect_view(p_event uuid, p_emp text) returns jsonb language sql stable as $$
  select coalesce(
    (select jsonb_build_object('status', case when c.collected_at is not null then 'collected' else 'ready' end,
            'employee_id', c.employee_id, 'name', c.participant_name, 'goodie', g.name, 'meal', c.meal,
            'image', dx_goodie_image(g), 'collected_at', c.collected_at, 'checked_in_at', c.checked_in_at)
       from goodie_choices c join goodies g on g.id = c.goodie_id
      where c.event_id = p_event and c.employee_id = p_emp),
    (select jsonb_build_object('status', 'declined', 'employee_id', d.employee_id, 'name', d.participant_name, 'came_at', d.attended_at)
       from goodie_declines d where d.event_id = p_event and d.employee_id = p_emp),
    jsonb_build_object('status', 'none', 'employee_id', p_emp, 'name', dx_lookup_person(p_event, p_emp) ->> 'name'));
$$;

create or replace function collect_checkin(p_event uuid, p_employee_id text) returns jsonb language plpgsql as $$
declare v_emp text := dx_norm_employee(p_employee_id);
begin
  if v_emp !~ '^[A-Z0-9._/-]{2,40}$' then perform dx_raise('INVALID_INPUT', 'Enter a valid employee ID'); end if;
  update goodie_choices set checked_in_at = now()
   where event_id = p_event and employee_id = v_emp and collected_at is null;
  -- said "No" but turned up: note it so the desk sees it
  update goodie_declines set attended_at = coalesce(attended_at, now())
   where event_id = p_event and employee_id = v_emp;
  return dx_collect_view(p_event, v_emp);
end $$;

create or replace function desk_queue(p_event uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'queue', coalesce((select jsonb_agg(jsonb_build_object('employee_id', c.employee_id, 'name', c.participant_name,
                 'goodie', g.name, 'meal', c.meal, 'image', dx_goodie_image(g), 'checked_in_at', c.checked_in_at) order by c.checked_in_at)
               from goodie_choices c join goodies g on g.id = c.goodie_id
              where c.event_id = p_event and c.checked_in_at is not null and c.collected_at is null), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(x order by x ->> 'collected_at' desc) from (
               select jsonb_build_object('employee_id', c.employee_id, 'name', c.participant_name, 'goodie', g.name,
                                         'collected_at', c.collected_at, 'collected_by', c.collected_by) x
                 from goodie_choices c join goodies g on g.id = c.goodie_id
                where c.event_id = p_event and c.collected_at is not null
                order by c.collected_at desc limit 8) t), '[]'::jsonb),
    'came_anyway', coalesce((select jsonb_agg(jsonb_build_object('employee_id', d.employee_id, 'name', d.participant_name, 'came_at', d.attended_at) order by d.attended_at)
               from goodie_declines d where d.event_id = p_event and d.attended_at is not null and d.acknowledged_at is null), '[]'::jsonb),
    'collected', (select count(*) from goodie_choices where event_id = p_event and collected_at is not null),
    'total', (select count(*) from goodie_choices where event_id = p_event),
    'at', now());
$$;

create or replace function desk_mark(p_event uuid, p_employee_id text, p_action text, p_by text) returns jsonb language plpgsql as $$
declare v_emp text := dx_norm_employee(p_employee_id); c goodie_choices; v_goodie text;
begin
  -- someone who said No but came: mark them as here (and clear them from the desk list)
  if p_action in ('came', 'ack') then
    update goodie_declines set attended_at = coalesce(attended_at, now()), acknowledged_at = now(), acknowledged_by = left(p_by, 60)
     where event_id = p_event and employee_id = v_emp;
    if not found then perform dx_raise('NOT_FOUND', v_emp || ' did not say No'); end if;
    perform dx_audit(p_event, 'system', 'desk:' || left(coalesce(p_by, '?'), 60), 'attendance.came_anyway', 'goodie_decline', v_emp, null,
                     jsonb_build_object('employee_id', v_emp, 'by', p_by));
    return dx_collect_view(p_event, v_emp);
  end if;
  select * into c from goodie_choices where event_id = p_event and employee_id = v_emp for update;
  if not found then
    if exists (select 1 from goodie_declines where event_id = p_event and employee_id = v_emp) then
      perform dx_raise('NOT_FOUND', v_emp || ' said they are not attending — no goodie booked');
    end if;
    perform dx_raise('NOT_FOUND', 'No goodie booked for ' || v_emp);
  end if;
  select name into v_goodie from goodies where id = c.goodie_id;
  if p_action = 'collect' then
    if c.collected_at is not null then
      perform dx_raise('ALREADY_RESERVED', c.participant_name || ' already collected ' || v_goodie || ' (' ||
                       to_char(c.collected_at at time zone 'Asia/Kolkata', 'HH12:MI am') || coalesce(', by ' || c.collected_by, '') || ')');
    end if;
    update goodie_choices set collected_at = now(), collected_by = left(p_by, 60), checked_in_at = coalesce(checked_in_at, now())
     where event_id = p_event and employee_id = v_emp;
  elsif p_action = 'undo' then
    if c.collected_at is null then perform dx_raise('INVALID_STATE', 'Not collected yet'); end if;
    if c.collected_at < now() - interval '15 minutes' then perform dx_raise('INVALID_STATE', 'Can only undo within 15 minutes — ask an organizer'); end if;
    update goodie_choices set collected_at = null, collected_by = null where event_id = p_event and employee_id = v_emp;
  elsif p_action = 'skip' then
    update goodie_choices set checked_in_at = null where event_id = p_event and employee_id = v_emp and collected_at is null;
  else
    perform dx_raise('INVALID_INPUT', 'Unknown action');
  end if;
  perform dx_audit(p_event, 'system', 'desk:' || left(coalesce(p_by, '?'), 60), 'goodie.' || p_action, 'goodie_choice', v_emp, null,
                   jsonb_build_object('employee_id', v_emp, 'name', c.participant_name, 'goodie', v_goodie, 'by', p_by));
  return dx_collect_view(p_event, v_emp);
end $$;

create or replace function admin_attendance_summary(p_event uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'yes', (select count(*) from goodie_choices where event_id = p_event and attending is not false),
    'no', (select count(*) from goodie_declines where event_id = p_event),
    'came_anyway', (select count(*) from goodie_declines where event_id = p_event and attended_at is not null),
    'by_employee', coalesce((select jsonb_object_agg(employee_id, a) from (
        select employee_id, attending is not false as a from goodie_choices where event_id = p_event
        union all select employee_id, false from goodie_declines where event_id = p_event) x), '{}'::jsonb),
    'declined', coalesce((select jsonb_agg(jsonb_build_object('employee_id', employee_id, 'name', participant_name, 'at', created_at, 'came_at', attended_at, 'marked_by', acknowledged_by) order by created_at desc)
        from goodie_declines where event_id = p_event), '[]'::jsonb));
$$;

-- How each pick was made (survey / autopick / offline), for the report.
create or replace function admin_choice_via(p_event uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_object_agg(employee_id, via), '{}'::jsonb) from goodie_choices where event_id = p_event;
$$;

-- Offline registrations. Rows: [{employee_id, name, meal, goodie}].
-- With a goodie: booked now (stock drops). Without: added to the list so they can pick via the QR.
create or replace function admin_offline_import(p_event uuid, p_rows jsonb, p_actor uuid) returns jsonb language plpgsql as $$
declare r jsonb; v_line int := 0; v_emp text; v_name text; v_meal text; v_goodie text; g goodies;
        v_booked int := 0; v_listed int := 0; v_bad jsonb := '[]'::jsonb; v_seen text[] := '{}';
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 3000 then perform dx_raise('INVALID_INPUT', 'Up to 3000 rows per upload'); end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_line := v_line + 1;
    v_emp := dx_norm_employee(r ->> 'employee_id');
    v_name := regexp_replace(btrim(coalesce(r ->> 'name', '')), '\s+', ' ', 'g');
    v_meal := case
      when lower(regexp_replace(coalesce(r ->> 'meal', ''), '[^a-zA-Z]', '', 'g')) in ('veg', 'v', 'vegetarian') then 'veg'
      when lower(regexp_replace(coalesce(r ->> 'meal', ''), '[^a-zA-Z]', '', 'g')) in ('nonveg', 'nv', 'nonvegetarian') then 'nonveg'
      else null end;
    v_goodie := nullif(btrim(coalesce(r ->> 'goodie', '')), '');
    if v_emp !~ '^[A-Z0-9._/-]{2,40}$' then
      v_bad := v_bad || jsonb_build_object('line', v_line, 'employee_id', r ->> 'employee_id', 'name', v_name, 'problem', 'invalid employee ID'); continue;
    end if;
    if char_length(v_name) not between 2 and 100 then
      v_bad := v_bad || jsonb_build_object('line', v_line, 'employee_id', v_emp, 'name', v_name, 'problem', 'missing name'); continue;
    end if;
    if v_emp = any(v_seen) then
      v_bad := v_bad || jsonb_build_object('line', v_line, 'employee_id', v_emp, 'name', v_name, 'problem', 'duplicate in file (first one kept)'); continue;
    end if;
    v_seen := v_seen || v_emp;
    if exists (select 1 from goodie_choices where event_id = p_event and employee_id = v_emp)
       or exists (select 1 from goodie_declines where event_id = p_event and employee_id = v_emp) then
      v_bad := v_bad || jsonb_build_object('line', v_line, 'employee_id', v_emp, 'name', v_name, 'problem', 'already responded'); continue;
    end if;

    insert into goodie_roster (event_id, employee_id, name) values (p_event, v_emp, v_name)
    on conflict (event_id, employee_id) do update set name = excluded.name;

    if v_goodie is null then
      v_listed := v_listed + 1;   -- they can choose themselves with the goodies QR
      continue;
    end if;
    if v_meal is null then
      v_bad := v_bad || jsonb_build_object('line', v_line, 'employee_id', v_emp, 'name', v_name, 'problem', 'Veg/Non-veg missing or not recognised (added to the list, no goodie booked)'); continue;
    end if;
    select * into g from goodies where event_id = p_event and lower(btrim(name)) = lower(v_goodie) for update;
    if not found then
      v_bad := v_bad || jsonb_build_object('line', v_line, 'employee_id', v_emp, 'name', v_name, 'problem', 'unknown goodie "' || v_goodie || '" (added to the list, no goodie booked)'); continue;
    end if;
    if dx_goodie_taken(g.id) >= g.stock then
      v_bad := v_bad || jsonb_build_object('line', v_line, 'employee_id', v_emp, 'name', v_name, 'problem', g.name || ' is out of stock (added to the list, no goodie booked)'); continue;
    end if;
    insert into goodie_choices (event_id, goodie_id, employee_id, participant_name, via, meal, attending)
    values (p_event, g.id, v_emp, v_name, 'offline', v_meal, true);
    v_booked := v_booked + 1;
  end loop;
  perform dx_audit(p_event, 'admin', p_actor::text, 'offline.imported', 'goodie_choice', p_event::text, null,
                   jsonb_build_object('booked', v_booked, 'listed', v_listed, 'skipped', jsonb_array_length(v_bad)));
  return jsonb_build_object('booked', v_booked, 'listed', v_listed, 'skipped', v_bad);
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
