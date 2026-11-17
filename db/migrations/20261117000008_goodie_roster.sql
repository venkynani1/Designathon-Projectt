-- =====================================================================
-- Goodies participant list (employee ID + name), uploaded by the organizer.
-- The survey looks the name up from the employee ID; when a list exists,
-- only listed employee IDs can choose. Plus a live "recent picks" feed.
-- =====================================================================

create table if not exists goodie_roster (
  event_id    uuid not null references events(id),
  employee_id text not null check (employee_id ~ '^[A-Z0-9._/-]{2,40}$'),
  name        text not null check (char_length(name) between 2 and 100),
  email       text,
  department  text,
  created_at  timestamptz not null default now(),
  primary key (event_id, employee_id)
);
alter table goodie_roster enable row level security;
drop policy if exists server_all on goodie_roster;
create policy server_all on goodie_roster for all to service_role using (true) with check (true);
grant select, insert, update, delete on goodie_roster to service_role;

create index if not exists choice_event_time_idx on goodie_choices (event_id, created_at desc);

-- Who is this employee? Uploaded list first, then team registrations.
create or replace function dx_lookup_person(p_event uuid, p_emp text) returns jsonb language sql stable as $$
  select coalesce(
    (select jsonb_build_object('name', r.name, 'email', r.email, 'department', r.department, 'source', 'list')
       from goodie_roster r where r.event_id = p_event and r.employee_id = p_emp),
    (select jsonb_build_object('name', s.participant_name, 'email', s.email, 'department', null, 'source', 'registration')
       from participant_slots s where s.event_id = p_event and s.occupancy = 'occupied' and s.employee_id = p_emp));
$$;

create or replace function survey_lookup(p_event uuid, p_employee_id text) returns jsonb language sql stable as $$
  with p as (select dx_norm_employee(p_employee_id) as emp)
  select jsonb_build_object(
    'employee_id', p.emp,
    'found', dx_lookup_person(p_event, p.emp) is not null,
    'name', dx_lookup_person(p_event, p.emp) ->> 'name',
    'list_required', exists (select 1 from goodie_roster where event_id = p_event),
    'chosen', (select g.name from goodie_choices c join goodies g on g.id = c.goodie_id
                where c.event_id = p_event and c.employee_id = p.emp))
  from p;
$$;

create or replace function survey_feed(p_event uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'event', e.name,
    'open', e.goodies_open,
    'list_required', exists (select 1 from goodie_roster where event_id = e.id),
    'goodies', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', g.id, 'name', g.name, 'description', g.description, 'stock', g.stock,
                  'left', greatest(g.stock - dx_goodie_taken(g.id), 0), 'image', dx_goodie_image(g))
                order by g.sort_order, g.name)
                from goodies g where g.event_id = e.id and g.is_active), '[]'::jsonb),
    -- live activity: first name only
    'recent', coalesce((select jsonb_agg(x order by x ->> 'at' desc) from (
                  select jsonb_build_object('who', split_part(c.participant_name, ' ', 1), 'goodie', g.name, 'at', c.created_at) x
                  from goodie_choices c join goodies g on g.id = c.goodie_id
                  where c.event_id = e.id order by c.created_at desc limit 8) t), '[]'::jsonb),
    'chosen_total', (select count(*) from goodie_choices where event_id = e.id),
    'at', now())
  from events e where e.id = p_event;
$$;

create or replace function survey_submit(p_event uuid, p_employee_id text, p_name text, p_goodie uuid) returns jsonb
language plpgsql as $$
declare e events; g goodies; v_emp text := dx_norm_employee(p_employee_id);
        v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_prev text; v_slot uuid; v_person jsonb;
begin
  select * into e from events where id = p_event;
  if not found then perform dx_raise('NOT_FOUND', 'Event not found'); end if;
  if not e.goodies_open then perform dx_raise('ARENA_CLOSED', 'The goodies survey is closed right now'); end if;
  if v_emp !~ '^[A-Z0-9._/-]{2,40}$' then perform dx_raise('INVALID_INPUT', 'Enter a valid employee ID'); end if;

  v_person := dx_lookup_person(p_event, v_emp);
  if v_person is not null then
    v_name := v_person ->> 'name';                                   -- the official name always wins
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

  select * into g from goodies where id = p_goodie and event_id = p_event and is_active for update;
  if not found then perform dx_raise('NOT_FOUND', 'That goodie is no longer available'); end if;
  if dx_goodie_taken(g.id) >= g.stock then perform dx_raise('OUT_OF_STOCK', g.name || ' just ran out — please pick another'); end if;

  select id into v_slot from participant_slots where event_id = p_event and occupancy = 'occupied' and employee_id = v_emp;
  begin
    insert into goodie_choices (event_id, goodie_id, employee_id, participant_name, slot_id)
    values (p_event, g.id, v_emp, v_name, v_slot);
  exception when unique_violation then
    perform dx_raise('ALREADY_RESERVED', 'Employee ID ' || v_emp || ' has already chosen a goodie');
  end;
  perform dx_audit(p_event, 'participant', v_emp, 'goodie.chosen', 'goodie', g.id::text, null,
                   jsonb_build_object('employee_id', v_emp, 'name', v_name, 'goodie', g.name));
  return jsonb_build_object('goodie', g.name, 'employee_id', v_emp, 'name', v_name, 'feed', survey_feed(p_event));
end $$;

-- ---------------------------------------------------------------------
-- Organizer: participant list
-- ---------------------------------------------------------------------
-- p_rows: [{employee_id, name, email?, department?}]. Invalid rows are skipped and reported.
create or replace function admin_roster_import(p_event uuid, p_rows jsonb, p_replace boolean, p_actor uuid) returns jsonb
language plpgsql as $$
declare r jsonb; v_emp text; v_name text; v_added int := 0; v_updated int := 0; v_bad jsonb := '[]'::jsonb; v_line int := 0;
        v_seen text[] := '{}'; v_ins boolean;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    perform dx_raise('INVALID_INPUT', 'Up to 5000 people per upload');
  end if;
  if coalesce(p_replace, false) then delete from goodie_roster where event_id = p_event; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_line := v_line + 1;
    v_emp := dx_norm_employee(r ->> 'employee_id');
    v_name := regexp_replace(btrim(coalesce(r ->> 'name', '')), '\s+', ' ', 'g');
    if v_emp !~ '^[A-Z0-9._/-]{2,40}$' or char_length(v_name) not between 2 and 100 then
      v_bad := v_bad || jsonb_build_object('line', v_line, 'employee_id', r ->> 'employee_id', 'name', r ->> 'name',
                                           'problem', case when v_emp !~ '^[A-Z0-9._/-]{2,40}$' then 'invalid employee ID' else 'missing name' end);
      continue;
    end if;
    if v_emp = any(v_seen) then
      v_bad := v_bad || jsonb_build_object('line', v_line, 'employee_id', v_emp, 'name', v_name, 'problem', 'duplicate in file (first one kept)');
      continue;
    end if;
    v_seen := v_seen || v_emp;
    insert into goodie_roster (event_id, employee_id, name, email, department)
    values (p_event, v_emp, v_name, nullif(lower(btrim(coalesce(r ->> 'email', ''))), ''), nullif(btrim(coalesce(r ->> 'department', '')), ''))
    on conflict (event_id, employee_id) do update
      set name = excluded.name, email = coalesce(excluded.email, goodie_roster.email), department = coalesce(excluded.department, goodie_roster.department)
    returning (xmax = 0) into v_ins;
    if v_ins then v_added := v_added + 1; else v_updated := v_updated + 1; end if;
  end loop;
  perform dx_audit(p_event, 'admin', p_actor::text, 'roster.imported', 'roster', p_event::text, null,
                   jsonb_build_object('added', v_added, 'updated', v_updated, 'skipped', jsonb_array_length(v_bad), 'replace', p_replace));
  return jsonb_build_object('added', v_added, 'updated', v_updated, 'skipped', v_bad,
                            'total', (select count(*) from goodie_roster where event_id = p_event));
end $$;

create or replace function admin_roster_list(p_event uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'employee_id', r.employee_id, 'name', r.name, 'email', r.email, 'department', r.department,
           'goodie', g.name, 'chosen_at', c.created_at) order by r.name), '[]'::jsonb)
  from goodie_roster r
  left join goodie_choices c on c.event_id = r.event_id and c.employee_id = r.employee_id
  left join goodies g on g.id = c.goodie_id
  where r.event_id = p_event;
$$;

create or replace function admin_roster_save(p_event uuid, p_employee_id text, p_name text, p_email text, p_department text,
                                             p_original text, p_actor uuid) returns void language plpgsql as $$
declare v_emp text := dx_norm_employee(p_employee_id); v_orig text := nullif(dx_norm_employee(p_original), '');
        v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  if v_emp !~ '^[A-Z0-9._/-]{2,40}$' then perform dx_raise('INVALID_INPUT', 'Enter a valid employee ID'); end if;
  if char_length(v_name) not between 2 and 100 then perform dx_raise('INVALID_INPUT', 'Enter a name (2–100 characters)'); end if;
  if v_orig is not null and v_orig <> v_emp then
    if exists (select 1 from goodie_choices where event_id = p_event and employee_id = v_orig) then
      perform dx_raise('INVALID_STATE', 'This person already chose a goodie — their employee ID can''t be changed');
    end if;
    delete from goodie_roster where event_id = p_event and employee_id = v_orig;
  end if;
  if v_orig is null and exists (select 1 from goodie_roster where event_id = p_event and employee_id = v_emp) then
    perform dx_raise('INVALID_STATE', 'Employee ID ' || v_emp || ' is already in the list');
  end if;
  insert into goodie_roster (event_id, employee_id, name, email, department)
  values (p_event, v_emp, v_name, nullif(lower(btrim(coalesce(p_email, ''))), ''), nullif(btrim(coalesce(p_department, '')), ''))
  on conflict (event_id, employee_id) do update set name = excluded.name, email = excluded.email, department = excluded.department;
  -- keep the report consistent with the corrected name
  update goodie_choices set participant_name = v_name where event_id = p_event and employee_id = v_emp;
  perform dx_audit(p_event, 'admin', p_actor::text, 'roster.saved', 'roster', v_emp, null, jsonb_build_object('name', v_name));
end $$;

create or replace function admin_roster_delete(p_event uuid, p_employee_id text, p_actor uuid) returns void language plpgsql as $$
declare v_emp text := dx_norm_employee(p_employee_id);
begin
  delete from goodie_roster where event_id = p_event and employee_id = v_emp;
  if not found then perform dx_raise('NOT_FOUND', 'Not in the list'); end if;
  perform dx_audit(p_event, 'admin', p_actor::text, 'roster.deleted', 'roster', v_emp, null, null);
end $$;

create or replace function admin_roster_clear(p_event uuid, p_actor uuid) returns int language plpgsql as $$
declare n int;
begin
  delete from goodie_roster where event_id = p_event;
  get diagnostics n = row_count;
  perform dx_audit(p_event, 'admin', p_actor::text, 'roster.cleared', 'roster', p_event::text, null, jsonb_build_object('removed', n));
  return n;
end $$;

-- Report: everyone who chose + everyone (list or registration) who hasn't yet.
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
                  union all
                  select jsonb_build_object('employee_id', s.employee_id, 'name', s.participant_name, 'email', s.email,
                                            'department', null, 'team_number', t.team_number, 'team_name', t.name)
                    from participant_slots s join teams t on t.id = s.team_id
                   where s.event_id = p_event and s.occupancy = 'occupied'
                     and not exists (select 1 from goodie_roster r where r.event_id = p_event and r.employee_id = s.employee_id)
                     and not exists (select 1 from goodie_choices c where c.event_id = p_event and c.employee_id = s.employee_id)) t), '[]'::jsonb),
    'goodies', admin_list_goodies(p_event),
    'roster_size', (select count(*) from goodie_roster where event_id = p_event));
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
