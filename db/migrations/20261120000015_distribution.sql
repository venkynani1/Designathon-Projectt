-- =====================================================================
-- Goodie distribution: one shared QR at the desk, many distributors.
-- Participant scans, enters employee ID -> joins the shared queue and sees their goodie.
-- Any distributor marks "Collected"; only the first tap counts.
-- =====================================================================
alter table goodie_choices add column if not exists checked_in_at timestamptz;
alter table goodie_choices add column if not exists collected_at  timestamptz;
alter table goodie_choices add column if not exists collected_by  text;
create index if not exists choice_queue_idx on goodie_choices (event_id, checked_in_at) where collected_at is null and checked_in_at is not null;

create table if not exists distribution_desk (
  event_id    uuid primary key references events(id),
  pin         text not null check (pin ~ '^[0-9]{4,8}$'),
  pin_version int not null default 1,
  updated_at  timestamptz not null default now()
);
alter table distribution_desk enable row level security;
drop policy if exists server_all on distribution_desk;
create policy server_all on distribution_desk for all to service_role using (true) with check (true);
grant select, insert, update, delete on distribution_desk to service_role;

create or replace function dx_rand_pin() returns text language sql volatile as $$
  select lpad((floor(random() * 1000000))::int::text, 6, '0');
$$;

create or replace function admin_desk_get(p_event uuid) returns jsonb language plpgsql as $$
declare d distribution_desk;
begin
  select * into d from distribution_desk where event_id = p_event;
  if not found then
    insert into distribution_desk (event_id, pin) values (p_event, dx_rand_pin()) returning * into d;
  end if;
  return jsonb_build_object('pin', d.pin, 'version', d.pin_version);
end $$;

create or replace function admin_desk_new_pin(p_event uuid, p_actor uuid) returns jsonb language plpgsql as $$
declare d distribution_desk;
begin
  perform admin_desk_get(p_event);
  update distribution_desk set pin = dx_rand_pin(), pin_version = pin_version + 1, updated_at = now()
   where event_id = p_event returning * into d;
  perform dx_audit(p_event, 'admin', p_actor::text, 'desk.pin_changed', 'desk', p_event::text, null, null);
  return jsonb_build_object('pin', d.pin, 'version', d.pin_version);
end $$;

-- returns the pin version if the PIN is right, else null
create or replace function desk_check_pin(p_event uuid, p_pin text) returns int language sql stable as $$
  select pin_version from distribution_desk where event_id = p_event and pin = btrim(coalesce(p_pin, ''));
$$;

create or replace function desk_pin_version(p_event uuid) returns int language sql stable as $$
  select pin_version from distribution_desk where event_id = p_event;
$$;

-- What a participant sees (and what the desk sees for one person).
create or replace function dx_collect_view(p_event uuid, p_emp text) returns jsonb language sql stable as $$
  select coalesce(
    (select jsonb_build_object('status', case when c.collected_at is not null then 'collected' else 'ready' end,
            'employee_id', c.employee_id, 'name', c.participant_name, 'goodie', g.name, 'meal', c.meal,
            'image', dx_goodie_image(g), 'collected_at', c.collected_at, 'checked_in_at', c.checked_in_at)
       from goodie_choices c join goodies g on g.id = c.goodie_id
      where c.event_id = p_event and c.employee_id = p_emp),
    (select jsonb_build_object('status', 'declined', 'employee_id', d.employee_id, 'name', d.participant_name)
       from goodie_declines d where d.event_id = p_event and d.employee_id = p_emp),
    jsonb_build_object('status', 'none', 'employee_id', p_emp, 'name', dx_lookup_person(p_event, p_emp) ->> 'name'));
$$;

-- Participant scanned and entered their ID: join the queue (or move back to the end if re-scanned).
create or replace function collect_checkin(p_event uuid, p_employee_id text) returns jsonb language plpgsql as $$
declare v_emp text := dx_norm_employee(p_employee_id);
begin
  if v_emp !~ '^[A-Z0-9._/-]{2,40}$' then perform dx_raise('INVALID_INPUT', 'Enter a valid employee ID'); end if;
  update goodie_choices set checked_in_at = now()
   where event_id = p_event and employee_id = v_emp and collected_at is null;
  return dx_collect_view(p_event, v_emp);
end $$;

create or replace function collect_status(p_event uuid, p_employee_id text) returns jsonb language sql stable as $$
  select dx_collect_view(p_event, dx_norm_employee(p_employee_id));
$$;

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
    'collected', (select count(*) from goodie_choices where event_id = p_event and collected_at is not null),
    'total', (select count(*) from goodie_choices where event_id = p_event),
    'at', now());
$$;

-- action: collect | undo | skip (remove from queue without collecting)
create or replace function desk_mark(p_event uuid, p_employee_id text, p_action text, p_by text) returns jsonb language plpgsql as $$
declare v_emp text := dx_norm_employee(p_employee_id); c goodie_choices; v_goodie text;
begin
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

-- Organizer: collection overview.
create or replace function admin_distribution_summary(p_event uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'collected', (select count(*) from goodie_choices where event_id = p_event and collected_at is not null),
    'total', (select count(*) from goodie_choices where event_id = p_event),
    'in_queue', (select count(*) from goodie_choices where event_id = p_event and checked_in_at is not null and collected_at is null),
    'by_goodie', coalesce((select jsonb_agg(jsonb_build_object('name', g.name,
                   'chosen', (select count(*) from goodie_choices c where c.goodie_id = g.id),
                   'collected', (select count(*) from goodie_choices c where c.goodie_id = g.id and c.collected_at is not null)) order by g.sort_order, g.name)
                 from goodies g where g.event_id = p_event), '[]'::jsonb),
    'by_employee', coalesce((select jsonb_object_agg(employee_id, jsonb_build_object('at', collected_at, 'by', collected_by))
                   from goodie_choices where event_id = p_event and collected_at is not null), '{}'::jsonb));
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
