-- =====================================================================
-- Veg / Non-veg meal preference, chosen with the goodie (same link/QR).
-- =====================================================================
alter table goodie_choices   add column if not exists meal text check (meal in ('veg', 'nonveg'));
alter table goodie_autopicks add column if not exists meal text check (meal in ('veg', 'nonveg'));

drop function if exists survey_submit(uuid, text, text, uuid);
drop function if exists admin_autopick_save(uuid, text, text, uuid[], uuid);

-- dx_autopick_assign takes the table row type; recreate so it picks up the new column.
create or replace function dx_autopick_assign(a goodie_autopicks) returns text language plpgsql as $$
declare g goodies; v_id uuid;
begin
  if exists (select 1 from goodie_choices where event_id = a.event_id and employee_id = a.employee_id) then return null; end if;
  foreach v_id in array a.prefs loop
    select * into g from goodies where id = v_id and event_id = a.event_id and is_active for update;
    continue when not found;
    if dx_goodie_taken(g.id) < g.stock then
      insert into goodie_choices (event_id, goodie_id, employee_id, participant_name, via, meal)
      values (a.event_id, g.id, a.employee_id, a.name, 'autopick', a.meal);
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

create or replace function survey_submit(p_event uuid, p_employee_id text, p_name text, p_goodie uuid, p_meal text) returns jsonb
language plpgsql as $$
declare e events; g goodies; v_emp text := dx_norm_employee(p_employee_id);
        v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_prev text; v_slot uuid; v_person jsonb;
begin
  select * into e from events where id = p_event;
  if not found then perform dx_raise('NOT_FOUND', 'Event not found'); end if;
  if not e.goodies_open then perform dx_raise('ARENA_CLOSED', 'The goodies survey is closed right now'); end if;
  perform autopick_run_pending(p_event);
  if p_meal is null or p_meal not in ('veg', 'nonveg') then perform dx_raise('INVALID_INPUT', 'Choose Veg or Non-veg'); end if;
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
    insert into goodie_choices (event_id, goodie_id, employee_id, participant_name, slot_id, meal)
    values (p_event, g.id, v_emp, v_name, v_slot, p_meal);
  exception when unique_violation then
    perform dx_raise('ALREADY_RESERVED', 'Employee ID ' || v_emp || ' has already chosen a goodie');
  end;
  perform dx_audit(p_event, 'participant', v_emp, 'goodie.chosen', 'goodie', g.id::text, null,
                   jsonb_build_object('employee_id', v_emp, 'name', v_name, 'goodie', g.name, 'meal', p_meal));
  return jsonb_build_object('goodie', g.name, 'employee_id', v_emp, 'name', v_name, 'meal', p_meal, 'feed', survey_feed(p_event));
end $$;

create or replace function admin_autopick_save(p_event uuid, p_employee_id text, p_name text, p_prefs uuid[], p_meal text, p_actor uuid)
returns jsonb language plpgsql as $$
declare v_emp text := dx_norm_employee(p_employee_id);
        v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_token text; v_bad int;
begin
  if v_emp !~ '^[A-Z0-9._/-]{2,40}$' then perform dx_raise('INVALID_INPUT', 'Enter a valid employee ID'); end if;
  if v_name = '' then v_name := coalesce(dx_lookup_person(p_event, v_emp) ->> 'name', ''); end if;
  if char_length(v_name) not between 2 and 100 then perform dx_raise('INVALID_INPUT', 'Enter a name (not found in the participant list)'); end if;
  if p_meal is null or p_meal not in ('veg', 'nonveg') then perform dx_raise('INVALID_INPUT', 'Choose Veg or Non-veg'); end if;
  if p_prefs is null or cardinality(p_prefs) = 0 then perform dx_raise('INVALID_INPUT', 'Choose at least one goodie'); end if;
  select count(*) into v_bad from unnest(p_prefs) u(id) where not exists (select 1 from goodies g where g.id = u.id and g.event_id = p_event);
  if v_bad > 0 then perform dx_raise('INVALID_INPUT', 'Unknown goodie in preferences'); end if;
  insert into goodie_autopicks (event_id, employee_id, name, prefs, meal, token)
  values (p_event, v_emp, v_name, p_prefs, p_meal, replace(gen_random_uuid()::text, '-', ''))
  on conflict (event_id, employee_id) do update set name = excluded.name, prefs = excluded.prefs, meal = excluded.meal, failed_at = null
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
           'employee_id', a.employee_id, 'name', a.name, 'token', a.token, 'prefs', a.prefs, 'meal', a.meal,
           'pref_names', (select jsonb_agg(g.name order by u.ord) from unnest(a.prefs) with ordinality u(id, ord) join goodies g on g.id = u.id),
           'goodie', (select g.name from goodie_choices c join goodies g on g.id = c.goodie_id where c.event_id = a.event_id and c.employee_id = a.employee_id),
           'failed', a.failed_at is not null,
           'chosen_at', (select c.created_at from goodie_choices c where c.event_id = a.event_id and c.employee_id = a.employee_id))
         order by a.created_at), '[]'::jsonb)
  from goodie_autopicks a where a.event_id = p_event;
$$;

-- Meal per person (for the report and organizer pages).
create or replace function admin_meal_summary(p_event uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'veg', (select count(*) from goodie_choices where event_id = p_event and meal = 'veg'),
    'nonveg', (select count(*) from goodie_choices where event_id = p_event and meal = 'nonveg'),
    'unknown', (select count(*) from goodie_choices where event_id = p_event and meal is null),
    'by_employee', coalesce((select jsonb_object_agg(employee_id, meal) from goodie_choices where event_id = p_event and meal is not null), '{}'::jsonb));
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
