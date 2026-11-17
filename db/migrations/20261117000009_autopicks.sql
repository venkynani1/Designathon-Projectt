-- =====================================================================
-- Auto-picks: organizer sets employee ID + name + ordered goodie preferences;
-- each person gets a personal link that claims their goodie the moment it's opened
-- (or the moment choosing opens). Stock drops immediately like any other choice.
-- =====================================================================

alter table goodie_choices add column if not exists via text not null default 'survey' check (via in ('survey', 'autopick'));

create table if not exists goodie_autopicks (
  event_id    uuid not null references events(id),
  employee_id text not null check (employee_id ~ '^[A-Z0-9._/-]{2,40}$'),
  name        text not null check (char_length(name) between 2 and 100),
  prefs       uuid[] not null check (cardinality(prefs) between 1 and 10),
  token       text not null unique check (token ~ '^[a-f0-9]{32}$'),
  created_at  timestamptz not null default now(),
  failed_at   timestamptz,           -- set when none of the preferences had stock left at assignment time
  primary key (event_id, employee_id)
);
alter table goodie_autopicks enable row level security;
drop policy if exists server_all on goodie_autopicks;
create policy server_all on goodie_autopicks for all to service_role using (true) with check (true);
grant select, insert, update, delete on goodie_autopicks to service_role;

create or replace function admin_autopick_save(p_event uuid, p_employee_id text, p_name text, p_prefs uuid[], p_actor uuid)
returns jsonb language plpgsql as $$
declare v_emp text := dx_norm_employee(p_employee_id);
        v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_token text; v_bad int;
begin
  if v_emp !~ '^[A-Z0-9._/-]{2,40}$' then perform dx_raise('INVALID_INPUT', 'Enter a valid employee ID'); end if;
  if v_name = '' then v_name := coalesce(dx_lookup_person(p_event, v_emp) ->> 'name', ''); end if;
  if char_length(v_name) not between 2 and 100 then perform dx_raise('INVALID_INPUT', 'Enter a name (not found in the participant list)'); end if;
  if p_prefs is null or cardinality(p_prefs) = 0 then perform dx_raise('INVALID_INPUT', 'Choose at least one goodie'); end if;
  select count(*) into v_bad from unnest(p_prefs) u(id) where not exists (select 1 from goodies g where g.id = u.id and g.event_id = p_event);
  if v_bad > 0 then perform dx_raise('INVALID_INPUT', 'Unknown goodie in preferences'); end if;
  insert into goodie_autopicks (event_id, employee_id, name, prefs, token)
  values (p_event, v_emp, v_name, p_prefs, replace(gen_random_uuid()::text, '-', ''))
  on conflict (event_id, employee_id) do update set name = excluded.name, prefs = excluded.prefs, failed_at = null
  returning token into v_token;
  -- keep them in the participant list so name lookup and reports match
  insert into goodie_roster (event_id, employee_id, name) values (p_event, v_emp, v_name)
  on conflict (event_id, employee_id) do update set name = excluded.name;
  perform dx_audit(p_event, 'admin', p_actor::text, 'autopick.saved', 'autopick', v_emp, null,
                   jsonb_build_object('name', v_name, 'prefs', p_prefs));
  return jsonb_build_object('employee_id', v_emp, 'token', v_token);
end $$;

create or replace function admin_autopick_list(p_event uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'employee_id', a.employee_id, 'name', a.name, 'token', a.token, 'prefs', a.prefs,
           'pref_names', (select jsonb_agg(g.name order by u.ord) from unnest(a.prefs) with ordinality u(id, ord) join goodies g on g.id = u.id),
           'goodie', (select g.name from goodie_choices c join goodies g on g.id = c.goodie_id where c.event_id = a.event_id and c.employee_id = a.employee_id),
           'failed', a.failed_at is not null,
           'chosen_at', (select c.created_at from goodie_choices c where c.event_id = a.event_id and c.employee_id = a.employee_id))
         order by a.created_at), '[]'::jsonb)
  from goodie_autopicks a where a.event_id = p_event;
$$;

create or replace function admin_autopick_delete(p_event uuid, p_employee_id text, p_actor uuid) returns void language plpgsql as $$
declare v_emp text := dx_norm_employee(p_employee_id);
begin
  delete from goodie_autopicks where event_id = p_event and employee_id = v_emp;
  if not found then perform dx_raise('NOT_FOUND', 'Not found'); end if;
  perform dx_audit(p_event, 'admin', p_actor::text, 'autopick.deleted', 'autopick', v_emp, null, null);
end $$;

create or replace function autopick_peek(p_token text) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'name', a.name, 'employee_id', a.employee_id, 'open', e.goodies_open, 'event', e.name,
    'goodie', (select g.name from goodie_choices c join goodies g on g.id = c.goodie_id where c.event_id = a.event_id and c.employee_id = a.employee_id))
  from goodie_autopicks a join events e on e.id = a.event_id where a.token = p_token;
$$;

-- Gives one auto-pick person their first available preference. Caller holds the run lock.
create or replace function dx_autopick_assign(a goodie_autopicks) returns text language plpgsql as $$
declare g goodies; v_id uuid;
begin
  if exists (select 1 from goodie_choices where event_id = a.event_id and employee_id = a.employee_id) then return null; end if;
  foreach v_id in array a.prefs loop
    select * into g from goodies where id = v_id and event_id = a.event_id and is_active for update;
    continue when not found;
    if dx_goodie_taken(g.id) < g.stock then
      insert into goodie_choices (event_id, goodie_id, employee_id, participant_name, via)
      values (a.event_id, g.id, a.employee_id, a.name, 'autopick');
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

-- Runs on the first public visit (page, live counts, name lookup, submit) once choosing is open.
-- Assigns every pending auto-pick, in the order they were added. Cheap no-op when nothing is pending.
create or replace function autopick_run_pending(p_event uuid) returns int language plpgsql as $$
declare a goodie_autopicks; n int := 0;
begin
  if not exists (select 1 from events where id = p_event and goodies_open) then return 0; end if;
  if not exists (select 1 from goodie_autopicks x where x.event_id = p_event and x.failed_at is null
                 and not exists (select 1 from goodie_choices c where c.event_id = x.event_id and c.employee_id = x.employee_id)) then
    return 0;
  end if;
  perform pg_advisory_xact_lock(hashtext('dx-autopick:' || p_event::text));
  for a in select * from goodie_autopicks x where x.event_id = p_event and x.failed_at is null
             and not exists (select 1 from goodie_choices c where c.event_id = x.event_id and c.employee_id = x.employee_id)
           order by x.created_at loop
    if dx_autopick_assign(a) is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- Personal status link (optional): shows the person their goodie; triggers the run if needed.
create or replace function autopick_claim(p_token text) returns jsonb language plpgsql as $$
declare a goodie_autopicks; e events; v_goodie text;
begin
  select * into a from goodie_autopicks where token = p_token;
  if not found then perform dx_raise('NOT_FOUND', 'This link is not valid'); end if;
  select * into e from events where id = a.event_id;
  if e.goodies_open then perform autopick_run_pending(a.event_id); end if;
  select g.name into v_goodie from goodie_choices c join goodies g on g.id = c.goodie_id where c.event_id = a.event_id and c.employee_id = a.employee_id;
  if v_goodie is not null then return jsonb_build_object('goodie', v_goodie, 'name', a.name, 'employee_id', a.employee_id); end if;
  if not e.goodies_open then perform dx_raise('ARENA_CLOSED', 'Choosing isn''t open yet'); end if;
  perform dx_raise('OUT_OF_STOCK', 'All of your preferred goodies are gone — open the main goodies page to pick another');
end $$;

-- Listed people are always assigned before anyone's own submission is processed.
create or replace function survey_submit(p_event uuid, p_employee_id text, p_name text, p_goodie uuid) returns jsonb
language plpgsql as $$
declare e events; g goodies; v_emp text := dx_norm_employee(p_employee_id);
        v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_prev text; v_slot uuid; v_person jsonb;
begin
  select * into e from events where id = p_event;
  if not found then perform dx_raise('NOT_FOUND', 'Event not found'); end if;
  if not e.goodies_open then perform dx_raise('ARENA_CLOSED', 'The goodies survey is closed right now'); end if;
  perform autopick_run_pending(p_event);
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

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
