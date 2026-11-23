-- =====================================================================
-- No response -> default goodie (Laptop Bag) at the collect desk; meal chosen on the spot.
-- =====================================================================
alter table events add column if not exists default_goodie_id uuid references goodies(id) on delete set null;
update events e set default_goodie_id = (select g.id from goodies g where g.event_id = e.id and lower(btrim(g.name)) = 'laptop bag' limit 1)
 where e.default_goodie_id is null;

alter table goodie_choices drop constraint if exists goodie_choices_via_check;
alter table goodie_choices add constraint goodie_choices_via_check check (via in ('survey', 'autopick', 'offline', 'default'));

-- Gives a listed/registered person who never responded the event's default goodie (if in stock).
create or replace function dx_assign_default(p_event uuid, p_emp text) returns text language plpgsql as $$
declare e events; g goodies; v_person jsonb;
begin
  if exists (select 1 from goodie_choices where event_id = p_event and employee_id = p_emp)
     or exists (select 1 from goodie_declines where event_id = p_event and employee_id = p_emp) then return null; end if;
  v_person := dx_lookup_person(p_event, p_emp);
  if v_person is null then return null; end if;
  select * into e from events where id = p_event;
  if e.default_goodie_id is null then return null; end if;
  select * into g from goodies where id = e.default_goodie_id and event_id = p_event for update;
  if not found or dx_goodie_taken(g.id) >= g.stock then return null; end if;
  begin
    insert into goodie_choices (event_id, goodie_id, employee_id, participant_name, via, meal, attending)
    values (p_event, g.id, p_emp, v_person ->> 'name', 'default', null, true);
  exception when unique_violation then return null;
  end;
  perform dx_audit(p_event, 'system', 'desk', 'goodie.default_assigned', 'goodie', g.id::text, null,
                   jsonb_build_object('employee_id', p_emp, 'goodie', g.name));
  return g.name;
end $$;

create or replace function dx_collect_view(p_event uuid, p_emp text) returns jsonb language sql stable as $$
  select coalesce(
    (select jsonb_build_object('status', case when c.collected_at is not null then 'collected' else 'ready' end,
            'employee_id', c.employee_id, 'name', c.participant_name, 'goodie', g.name, 'meal', c.meal,
            'image', dx_goodie_image(g), 'collected_at', c.collected_at, 'checked_in_at', c.checked_in_at, 'via', c.via)
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
  -- didn't respond at all: give them the default goodie (meal is chosen on the spot)
  perform dx_assign_default(p_event, v_emp);
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
                 'goodie', g.name, 'meal', c.meal, 'image', dx_goodie_image(g), 'checked_in_at', c.checked_in_at, 'via', c.via) order by c.checked_in_at)
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

-- Meal chosen on the spot (phone or desk), any time before collection.
create or replace function collect_set_meal(p_event uuid, p_employee_id text, p_meal text) returns jsonb language plpgsql as $$
declare v_emp text := dx_norm_employee(p_employee_id);
begin
  if p_meal not in ('veg', 'nonveg') then perform dx_raise('INVALID_INPUT', 'Choose Veg or Non-veg'); end if;
  update goodie_choices set meal = p_meal where event_id = p_event and employee_id = v_emp and collected_at is null and meal is null;
  return dx_collect_view(p_event, v_emp);
end $$;

create or replace function desk_set_meal(p_event uuid, p_employee_id text, p_meal text, p_by text) returns jsonb language plpgsql as $$
declare v_emp text := dx_norm_employee(p_employee_id);
begin
  if p_meal not in ('veg', 'nonveg') then perform dx_raise('INVALID_INPUT', 'Choose Veg or Non-veg'); end if;
  update goodie_choices set meal = p_meal where event_id = p_event and employee_id = v_emp and collected_at is null;
  if not found then perform dx_raise('NOT_FOUND', 'No uncollected goodie for ' || v_emp); end if;
  perform dx_audit(p_event, 'system', 'desk:' || left(coalesce(p_by, '?'), 60), 'meal.set', 'goodie_choice', v_emp, null, jsonb_build_object('meal', p_meal));
  return dx_collect_view(p_event, v_emp);
end $$;

create or replace function admin_default_goodie(p_event uuid) returns jsonb language sql stable as $$
  select jsonb_build_object('goodie_id', e.default_goodie_id, 'name', g.name,
                            'left', case when g.id is null then null else greatest(g.stock - dx_goodie_taken(g.id), 0) end)
  from events e left join goodies g on g.id = e.default_goodie_id where e.id = p_event;
$$;

create or replace function admin_set_default_goodie(p_event uuid, p_goodie uuid, p_actor uuid) returns jsonb language plpgsql as $$
begin
  if p_goodie is not null and not exists (select 1 from goodies where id = p_goodie and event_id = p_event) then
    perform dx_raise('NOT_FOUND', 'Goodie not found');
  end if;
  update events set default_goodie_id = p_goodie where id = p_event;
  perform dx_audit(p_event, 'admin', p_actor::text, 'goodie.default_set', 'event', p_event::text, null, jsonb_build_object('goodie_id', p_goodie));
  return admin_default_goodie(p_event);
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
