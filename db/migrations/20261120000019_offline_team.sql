-- Offline registrations carry a Team Name too (for the team-wise reports).
create or replace function admin_offline_import(p_event uuid, p_rows jsonb, p_actor uuid) returns jsonb language plpgsql as $$
declare r jsonb; v_line int := 0; v_emp text; v_name text; v_meal text; v_goodie text; v_team text; g goodies;
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
    v_team := nullif(regexp_replace(btrim(coalesce(r ->> 'team', '')), '\s+', ' ', 'g'), '');
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

    insert into goodie_roster (event_id, employee_id, name, team_name) values (p_event, v_emp, v_name, left(v_team, 100))
    on conflict (event_id, employee_id) do update set name = excluded.name, team_name = coalesce(excluded.team_name, goodie_roster.team_name);

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
