-- =====================================================================
-- Teams for the reports, one response per phone.
-- =====================================================================
alter table goodie_roster   add column if not exists team_name text;
alter table goodie_choices  add column if not exists device_hash text;
alter table goodie_declines add column if not exists device_hash text;
create index if not exists choice_device_idx  on goodie_choices  (event_id, device_hash) where device_hash is not null;
create index if not exists decline_device_idx on goodie_declines (event_id, device_hash) where device_hash is not null;

drop function if exists survey_submit(uuid, text, text, uuid, text, boolean);

create or replace function survey_submit(p_event uuid, p_employee_id text, p_name text, p_goodie uuid, p_meal text, p_attending boolean, p_device text default null) returns jsonb
language plpgsql as $$
declare e events; g goodies; v_emp text := dx_norm_employee(p_employee_id);
        v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_prev text; v_slot uuid; v_person jsonb;
begin
  select * into e from events where id = p_event;
  if not found then perform dx_raise('NOT_FOUND', 'Event not found'); end if;
  if not e.goodies_open then perform dx_raise('ARENA_CLOSED', 'The goodies survey is closed right now'); end if;
  perform autopick_run_pending(p_event);
  -- one response per phone
  if p_device is not null then
    perform pg_advisory_xact_lock(hashtext('dx-dev:' || p_event::text || ':' || p_device));
    if exists (select 1 from goodie_choices where event_id = p_event and device_hash = p_device)
       or exists (select 1 from goodie_declines where event_id = p_event and device_hash = p_device) then
      perform dx_raise('ALREADY_RESERVED', 'This phone has already been used to respond. Each person must use their own phone.');
    end if;
  end if;
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
      insert into goodie_declines (event_id, employee_id, participant_name, device_hash) values (p_event, v_emp, v_name, p_device);
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
    insert into goodie_choices (event_id, goodie_id, employee_id, participant_name, slot_id, meal, attending, device_hash)
    values (p_event, g.id, v_emp, v_name, v_slot, p_meal, p_attending, p_device);
  exception when unique_violation then
    perform dx_raise('ALREADY_RESERVED', 'Employee ID ' || v_emp || ' has already chosen a goodie');
  end;
  perform dx_audit(p_event, 'participant', v_emp, 'goodie.chosen', 'goodie', g.id::text, null,
                   jsonb_build_object('employee_id', v_emp, 'name', v_name, 'goodie', g.name, 'meal', p_meal, 'attending', p_attending));
  return jsonb_build_object('goodie', g.name, 'employee_id', v_emp, 'name', v_name, 'meal', p_meal, 'attending', p_attending, 'feed', survey_feed(p_event));
end $$;

-- Team file: [{employee_id, name, team}]. Adds/updates people in the participant list with their team.
create or replace function admin_team_import(p_event uuid, p_rows jsonb, p_actor uuid) returns jsonb language plpgsql as $$
declare r jsonb; v_line int := 0; v_emp text; v_name text; v_team text; v_n int := 0; v_bad jsonb := '[]'::jsonb; v_seen text[] := '{}';
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then perform dx_raise('INVALID_INPUT', 'Up to 5000 rows per upload'); end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_line := v_line + 1;
    v_emp := dx_norm_employee(r ->> 'employee_id');
    v_name := regexp_replace(btrim(coalesce(r ->> 'name', '')), '\s+', ' ', 'g');
    v_team := nullif(regexp_replace(btrim(coalesce(r ->> 'team', '')), '\s+', ' ', 'g'), '');
    if v_emp !~ '^[A-Z0-9._/-]{2,40}$' then v_bad := v_bad || jsonb_build_object('line', v_line, 'employee_id', r ->> 'employee_id', 'problem', 'invalid employee ID'); continue; end if;
    if char_length(v_name) not between 2 and 100 then v_bad := v_bad || jsonb_build_object('line', v_line, 'employee_id', v_emp, 'problem', 'missing name'); continue; end if;
    if v_team is null then v_bad := v_bad || jsonb_build_object('line', v_line, 'employee_id', v_emp, 'name', v_name, 'problem', 'missing team name'); continue; end if;
    if v_emp = any(v_seen) then v_bad := v_bad || jsonb_build_object('line', v_line, 'employee_id', v_emp, 'name', v_name, 'problem', 'duplicate in file (first one kept)'); continue; end if;
    v_seen := v_seen || v_emp;
    insert into goodie_roster (event_id, employee_id, name, team_name) values (p_event, v_emp, v_name, left(v_team, 100))
    on conflict (event_id, employee_id) do update set name = excluded.name, team_name = excluded.team_name;
    v_n := v_n + 1;
  end loop;
  perform dx_audit(p_event, 'admin', p_actor::text, 'teams.imported', 'roster', p_event::text, null, jsonb_build_object('rows', v_n, 'skipped', jsonb_array_length(v_bad)));
  return jsonb_build_object('imported', v_n, 'teams', (select count(distinct lower(team_name)) from goodie_roster where event_id = p_event and team_name is not null), 'skipped', v_bad);
end $$;

-- One row per person for the team-wise reports. Groups numbered alphabetically by team name;
-- people with a response but no team go to "Unassigned" at the end.
create or replace function admin_team_rows(p_event uuid) returns jsonb language sql stable as $$
  with people as (
    select r.employee_id, r.name, r.team_name as team from goodie_roster r where r.event_id = p_event
    union
    select c.employee_id, c.participant_name, null from goodie_choices c
     where c.event_id = p_event and not exists (select 1 from goodie_roster r where r.event_id = p_event and r.employee_id = c.employee_id)
    union
    select d.employee_id, d.participant_name, null from goodie_declines d
     where d.event_id = p_event and not exists (select 1 from goodie_roster r where r.event_id = p_event and r.employee_id = d.employee_id)
  ), teams as (
    select lower(team) k, min(team) team, dense_rank() over (order by lower(min(team))) grp
      from people where team is not null group by lower(team)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'group', t.grp, 'team', coalesce(t.team, 'Unassigned'), 'employee_id', p.employee_id, 'name', p.name,
      'response', case when c.employee_id is not null then 'Attending' when d.employee_id is not null then 'Not attending' else 'No response' end,
      'goodie', g.name, 'meal', c.meal, 'collected_at', c.collected_at, 'collected_by', c.collected_by, 'came_at', d.attended_at)
    order by t.grp nulls last, lower(p.name)), '[]'::jsonb)
  from people p
  left join teams t on t.k = lower(p.team)
  left join goodie_choices c on c.event_id = p_event and c.employee_id = p.employee_id
  left join goodies g on g.id = c.goodie_id
  left join goodie_declines d on d.event_id = p_event and d.employee_id = p.employee_id;
$$;

create or replace function admin_leftover_goodies(p_event uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', g.name, 'stock', g.stock,
           'chosen', (select count(*) from goodie_choices c where c.goodie_id = g.id),
           'collected', (select count(*) from goodie_choices c where c.goodie_id = g.id and c.collected_at is not null)) order by g.sort_order, g.name), '[]'::jsonb)
  from goodies g where g.event_id = p_event;
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
