-- =====================================================================
-- Attendance first: "No" records the person as not attending (no goodie, no meal).
-- =====================================================================
create table if not exists goodie_declines (
  event_id         uuid not null references events(id),
  employee_id      text not null check (employee_id ~ '^[A-Z0-9._/-]{2,40}$'),
  participant_name text not null,
  created_at       timestamptz not null default now(),
  primary key (event_id, employee_id)
);
alter table goodie_declines enable row level security;
drop policy if exists server_all on goodie_declines;
create policy server_all on goodie_declines for all to service_role using (true) with check (true);
grant select, insert, update, delete on goodie_declines to service_role;

create or replace function survey_submit(p_event uuid, p_employee_id text, p_name text, p_goodie uuid, p_meal text, p_attending boolean) returns jsonb
language plpgsql as $$
declare e events; g goodies; v_emp text := dx_norm_employee(p_employee_id);
        v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_prev text; v_slot uuid; v_person jsonb;
begin
  select * into e from events where id = p_event;
  if not found then perform dx_raise('NOT_FOUND', 'Event not found'); end if;
  if not e.goodies_open then perform dx_raise('ARENA_CLOSED', 'The goodies survey is closed right now'); end if;
  perform autopick_run_pending(p_event);
  if p_attending is null then perform dx_raise('INVALID_INPUT', 'Tell us whether you will attend on 27 November'); end if;
  if p_attending and (p_meal is null or p_meal not in ('veg', 'nonveg')) then perform dx_raise('INVALID_INPUT', 'Choose Veg or Non-veg'); end if;
  if v_emp !~ '^[A-Z0-9._/-]{2,40}$' then perform dx_raise('INVALID_INPUT', 'Enter a valid employee ID'); end if;

  v_person := dx_lookup_person(p_event, v_emp);
  if v_person is not null then
    v_name := v_person ->> 'name';
  elsif exists (select 1 from goodie_roster where event_id = p_event) then
    perform dx_raise('NOT_FOUND', 'Employee ID ' || v_emp || ' is not in the participant list. Check the ID or contact the organizers.');
  end if;
  if char_length(v_name) not between 2 and 100 then perform dx_raise('INVALID_INPUT', 'Enter your full name'); end if;

  select g2.name into v_prev from goodie_choices c join goodies g2 on g2.id = c.goodie_id
   where c.event_id = p_event and c.employee_id = v_emp;
  if v_prev is null then
    select g2.name into v_prev from goodie_reservations r join goodies g2 on g2.id = r.goodie_id
     where r.event_id = p_event and r.employee_id = v_emp and r.status <> 'cancelled';
  end if;
  if v_prev is not null then
    perform dx_raise('ALREADY_RESERVED', 'Employee ID ' || v_emp || ' has already chosen: ' || v_prev);
  end if;
  if exists (select 1 from goodie_declines d where d.event_id = p_event and d.employee_id = v_emp) then
    perform dx_raise('ALREADY_RESERVED', 'Employee ID ' || v_emp || ' has already responded (not attending)');
  end if;

  -- Not attending: record it, no goodie or meal.
  if not p_attending then
    perform pg_advisory_xact_lock(hashtext('dx-resp:' || p_event::text || ':' || v_emp));
    if exists (select 1 from goodie_choices c where c.event_id = p_event and c.employee_id = v_emp) then
      perform dx_raise('ALREADY_RESERVED', 'Employee ID ' || v_emp || ' has already chosen a goodie');
    end if;
    begin
      insert into goodie_declines (event_id, employee_id, participant_name) values (p_event, v_emp, v_name);
    exception when unique_violation then
      perform dx_raise('ALREADY_RESERVED', 'Employee ID ' || v_emp || ' has already responded');
    end;
    perform dx_audit(p_event, 'participant', v_emp, 'attendance.declined', 'goodie_decline', v_emp, null, jsonb_build_object('employee_id', v_emp, 'name', v_name));
    return jsonb_build_object('goodie', null, 'employee_id', v_emp, 'name', v_name, 'meal', null, 'attending', false, 'feed', survey_feed(p_event));
  end if;

  select * into g from goodies where id = p_goodie and event_id = p_event and is_active for update;
  if not found then perform dx_raise('NOT_FOUND', 'That goodie is no longer available'); end if;
  if dx_goodie_taken(g.id) >= g.stock then perform dx_raise('OUT_OF_STOCK', g.name || ' just ran out — please pick another'); end if;

  perform pg_advisory_xact_lock(hashtext('dx-resp:' || p_event::text || ':' || v_emp));
  if exists (select 1 from goodie_declines d where d.event_id = p_event and d.employee_id = v_emp) then
    perform dx_raise('ALREADY_RESERVED', 'Employee ID ' || v_emp || ' has already responded');
  end if;
  select id into v_slot from participant_slots where event_id = p_event and occupancy = 'occupied' and employee_id = v_emp;
  begin
    insert into goodie_choices (event_id, goodie_id, employee_id, participant_name, slot_id, meal, attending)
    values (p_event, g.id, v_emp, v_name, v_slot, p_meal, p_attending);
  exception when unique_violation then
    perform dx_raise('ALREADY_RESERVED', 'Employee ID ' || v_emp || ' has already chosen a goodie');
  end;
  perform dx_audit(p_event, 'participant', v_emp, 'goodie.chosen', 'goodie', g.id::text, null,
                   jsonb_build_object('employee_id', v_emp, 'name', v_name, 'goodie', g.name, 'meal', p_meal, 'attending', p_attending));
  return jsonb_build_object('goodie', g.name, 'employee_id', v_emp, 'name', v_name, 'meal', p_meal, 'attending', p_attending, 'feed', survey_feed(p_event));
end $$;

create or replace function survey_lookup(p_event uuid, p_employee_id text) returns jsonb language sql stable as $$
  with p as (select dx_norm_employee(p_employee_id) as emp)
  select jsonb_build_object(
    'employee_id', p.emp,
    'found', dx_lookup_person(p_event, p.emp) is not null,
    'name', dx_lookup_person(p_event, p.emp) ->> 'name',
    'list_required', exists (select 1 from goodie_roster where event_id = p_event),
    'chosen', (select g.name from goodie_choices c join goodies g on g.id = c.goodie_id
                where c.event_id = p_event and c.employee_id = p.emp),
    'declined', exists (select 1 from goodie_declines d where d.event_id = p_event and d.employee_id = p.emp))
  from p;
$$;

create or replace function admin_attendance_summary(p_event uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'yes', (select count(*) from goodie_choices where event_id = p_event and attending is not false),
    'no', (select count(*) from goodie_declines where event_id = p_event),
    'by_employee', coalesce((select jsonb_object_agg(employee_id, a) from (
        select employee_id, attending is not false as a from goodie_choices where event_id = p_event
        union all select employee_id, false from goodie_declines where event_id = p_event) x), '{}'::jsonb),
    'declined', coalesce((select jsonb_agg(jsonb_build_object('employee_id', employee_id, 'name', participant_name, 'at', created_at) order by created_at desc)
        from goodie_declines where event_id = p_event), '[]'::jsonb));
$$;

create or replace function admin_survey_report(p_event uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'choices', coalesce((select jsonb_agg(jsonb_build_object(
                  'employee_id', c.employee_id, 'name', c.participant_name, 'goodie', g.name, 'chosen_at', c.created_at,
                  'registered', (dx_lookup_person(p_event, c.employee_id) is not null),
                  'registered_name', dx_lookup_person(p_event, c.employee_id) ->> 'name',
                  'email', dx_lookup_person(p_event, c.employee_id) ->> 'email',
                  'department', dx_lookup_person(p_event, c.employee_id) ->> 'department',
                  'team_number', t.team_number, 'team_name', t.name)
                order by c.created_at desc)
                from goodie_choices c join goodies g on g.id = c.goodie_id
                left join participant_slots s on s.event_id = c.event_id and s.occupancy = 'occupied' and s.employee_id = c.employee_id
                left join teams t on t.id = s.team_id
                where c.event_id = p_event), '[]'::jsonb),
    'pending', coalesce((select jsonb_agg(x order by x ->> 'name') from (
                  select jsonb_build_object('employee_id', r.employee_id, 'name', r.name, 'email', r.email,
                                            'department', r.department, 'team_number', null, 'team_name', null) x
                    from goodie_roster r
                   where r.event_id = p_event
                     and not exists (select 1 from goodie_choices c where c.event_id = p_event and c.employee_id = r.employee_id)
                     and not exists (select 1 from goodie_declines d where d.event_id = p_event and d.employee_id = r.employee_id)
                  union all
                  select jsonb_build_object('employee_id', s.employee_id, 'name', s.participant_name, 'email', s.email,
                                            'department', null, 'team_number', t.team_number, 'team_name', t.name)
                    from participant_slots s join teams t on t.id = s.team_id
                   where s.event_id = p_event and s.occupancy = 'occupied'
                     and not exists (select 1 from goodie_roster r where r.event_id = p_event and r.employee_id = s.employee_id)
                     and not exists (select 1 from goodie_choices c where c.event_id = p_event and c.employee_id = s.employee_id)
                     and not exists (select 1 from goodie_declines d where d.event_id = p_event and d.employee_id = s.employee_id)) t), '[]'::jsonb),
    'goodies', admin_list_goodies(p_event),
    'roster_size', (select count(*) from goodie_roster where event_id = p_event));
$$;

create or replace function admin_reset_choice(p_event uuid, p_employee_id text, p_actor uuid) returns void language plpgsql as $$
declare v_emp text := dx_norm_employee(p_employee_id); v_goodie text;
begin
  delete from goodie_choices c using goodies g
   where c.event_id = p_event and c.employee_id = v_emp and g.id = c.goodie_id returning g.name into v_goodie;
  if v_goodie is null then
    delete from goodie_declines where event_id = p_event and employee_id = v_emp;
    if not found then perform dx_raise('NOT_FOUND', 'No response found for ' || v_emp); end if;
    v_goodie := '(not attending)';
  end if;
  perform dx_audit(p_event, 'admin', p_actor::text, 'goodie.choice_reset', 'goodie_choice', v_emp, null,
                   jsonb_build_object('employee_id', v_emp, 'goodie', v_goodie));
end $$;

create or replace function admin_roster_list(p_event uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'employee_id', r.employee_id, 'name', r.name, 'email', r.email, 'department', r.department,
           'goodie', g.name, 'declined', exists (select 1 from goodie_declines d where d.event_id = r.event_id and d.employee_id = r.employee_id), 'chosen_at', c.created_at) order by r.name), '[]'::jsonb)
  from goodie_roster r
  left join goodie_choices c on c.event_id = r.event_id and c.employee_id = r.employee_id
  left join goodies g on g.id = c.goodie_id
  where r.event_id = p_event;
$$;

create or replace function dx_autopick_assign(a goodie_autopicks) returns text language plpgsql as $$
declare g goodies; v_id uuid;
begin
  if exists (select 1 from goodie_choices where event_id = a.event_id and employee_id = a.employee_id)
     or exists (select 1 from goodie_declines where event_id = a.event_id and employee_id = a.employee_id) then return null; end if;
  if not a.attending then
    insert into goodie_declines (event_id, employee_id, participant_name) values (a.event_id, a.employee_id, a.name);
    perform dx_audit(a.event_id, 'system', 'autopick', 'attendance.declined', 'goodie_decline', a.employee_id, null, jsonb_build_object('employee_id', a.employee_id, 'name', a.name));
    return '(not attending)';
  end if;
  foreach v_id in array a.prefs loop
    select * into g from goodies where id = v_id and event_id = a.event_id and is_active for update;
    continue when not found;
    if dx_goodie_taken(g.id) < g.stock then
      insert into goodie_choices (event_id, goodie_id, employee_id, participant_name, via, meal, attending)
      values (a.event_id, g.id, a.employee_id, a.name, 'autopick', a.meal, a.attending);
      perform dx_audit(a.event_id, 'system', 'autopick', 'goodie.auto_assigned', 'goodie', g.id::text, null,
                       jsonb_build_object('employee_id', a.employee_id, 'name', a.name, 'goodie', g.name, 'prefs', a.prefs));
      return g.name;
    end if;
  end loop;
  update goodie_autopicks set failed_at = now() where event_id = a.event_id and employee_id = a.employee_id;
  perform dx_audit(a.event_id, 'system', 'autopick', 'goodie.auto_assign_failed', 'autopick', a.employee_id, null,
                   jsonb_build_object('employee_id', a.employee_id, 'name', a.name, 'reason', 'no stock left in any preference'));
  return null;
end $$;

create or replace function autopick_run_pending(p_event uuid) returns int language plpgsql as $$
declare a goodie_autopicks; n int := 0;
begin
  if not exists (select 1 from events where id = p_event and goodies_open) then return 0; end if;
  if not exists (select 1 from goodie_autopicks x where x.event_id = p_event and x.failed_at is null
                 and not exists (select 1 from goodie_choices c where c.event_id = x.event_id and c.employee_id = x.employee_id)
                 and not exists (select 1 from goodie_declines d where d.event_id = x.event_id and d.employee_id = x.employee_id)) then
    return 0;
  end if;
  perform pg_advisory_xact_lock(hashtext('dx-autopick:' || p_event::text));
  for a in select * from goodie_autopicks x where x.event_id = p_event and x.failed_at is null
             and not exists (select 1 from goodie_choices c where c.event_id = x.event_id and c.employee_id = x.employee_id)
                 and not exists (select 1 from goodie_declines d where d.event_id = x.event_id and d.employee_id = x.employee_id)
           order by x.created_at loop
    if dx_autopick_assign(a) is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
