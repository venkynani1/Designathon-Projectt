-- =====================================================================
-- DESIGNATHON X — Migration 5: organizer-managed problem statements & goodies
-- Safety rules enforced here (not just in the UI):
--  * capacity / stock can never be set below what is already taken
--  * items that were already picked can't be deleted (hide them instead)
--  * edits lock the row, so they serialize with concurrent locks/reservations
-- =====================================================================
alter table goodies add column if not exists image_url text;
alter table goodies drop constraint if exists goodies_image_url_chk;
alter table goodies add constraint goodies_image_url_chk check (image_url is null or image_url ~ '^https://');

-- ------------------------------------------------------------- problems
create or replace function admin_list_problems(p_event uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'code', p.code, 'title', p.title, 'summary', p.summary, 'capacity', p.capacity,
           'document_url', p.document_url, 'is_active', p.is_active, 'sort_order', p.sort_order,
           'taken', (select count(*) from problem_assignments a where a.problem_id = p.id))
         order by p.sort_order, p.code), '[]'::jsonb)
  from problem_statements p where p.event_id = p_event;
$$;

create or replace function admin_upsert_problem(p_event uuid, p_id uuid, p_code text, p_title text, p_summary text,
                                                p_capacity int, p_document_url text, p_is_active boolean,
                                                p_sort_order int, p_actor uuid)
returns jsonb language plpgsql as $$
declare v_taken int; v_id uuid; v_code text := upper(btrim(coalesce(p_code, ''))); v_url text := nullif(btrim(coalesce(p_document_url, '')), '');
begin
  if v_code !~ '^[A-Z0-9][A-Z0-9_-]{0,19}$' then perform dx_raise('INVALID_INPUT', 'Code must be 1–20 letters, numbers, - or _ (e.g. PS-01)'); end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 2 and 160 then perform dx_raise('INVALID_INPUT', 'Title must be 2–160 characters'); end if;
  if p_capacity is null or p_capacity < 1 or p_capacity > 10000 then perform dx_raise('INVALID_INPUT', 'Team limit must be between 1 and 10000'); end if;
  if v_url is not null and v_url !~ '^https://' then perform dx_raise('INVALID_INPUT', 'Document link must start with https://'); end if;
  if p_id is not null then
    perform 1 from problem_statements where id = p_id and event_id = p_event for update;
    if not found then perform dx_raise('NOT_FOUND', 'Problem statement not found'); end if;
    select count(*) into v_taken from problem_assignments where problem_id = p_id;
    if p_capacity < v_taken then
      perform dx_raise('INVALID_INPUT', v_taken || ' teams have already locked this problem — the limit can''t go below that');
    end if;
  end if;
  begin
    if p_id is null then
      insert into problem_statements (event_id, code, title, summary, capacity, document_url, is_active, sort_order)
      values (p_event, v_code, btrim(p_title), nullif(btrim(coalesce(p_summary, '')), ''), p_capacity, v_url, coalesce(p_is_active, true),
              coalesce(p_sort_order, (select coalesce(max(sort_order), 0) + 1 from problem_statements where event_id = p_event)))
      returning id into v_id;
    else
      update problem_statements set code = v_code, title = btrim(p_title), summary = nullif(btrim(coalesce(p_summary, '')), ''),
             capacity = p_capacity, document_url = v_url, is_active = coalesce(p_is_active, is_active),
             sort_order = coalesce(p_sort_order, sort_order)
       where id = p_id returning id into v_id;
    end if;
  exception when unique_violation then
    perform dx_raise('INVALID_INPUT', 'Another problem statement already uses code ' || v_code);
  end;
  perform dx_audit(p_event, 'admin', p_actor::text, case when p_id is null then 'problem.created' else 'problem.updated' end,
                   'problem', v_id::text, null, jsonb_build_object('code', v_code, 'title', p_title, 'capacity', p_capacity, 'active', p_is_active));
  return jsonb_build_object('id', v_id);
end $$;

create or replace function admin_delete_problem(p_event uuid, p_id uuid, p_actor uuid) returns void language plpgsql as $$
declare p problem_statements;
begin
  select * into p from problem_statements where id = p_id and event_id = p_event for update;
  if not found then perform dx_raise('NOT_FOUND', 'Problem statement not found'); end if;
  if exists (select 1 from problem_assignments where problem_id = p_id) then
    perform dx_raise('INVALID_STATE', 'Teams have already locked this problem — hide it instead of deleting');
  end if;
  delete from problem_statements where id = p_id;
  perform dx_audit(p_event, 'admin', p_actor::text, 'problem.deleted', 'problem', p_id::text, null, jsonb_build_object('code', p.code, 'title', p.title));
end $$;

-- -------------------------------------------------------------- goodies
create or replace function admin_list_goodies(p_event uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', g.id, 'name', g.name, 'description', g.description, 'stock', g.stock, 'image_url', g.image_url,
           'is_active', g.is_active, 'sort_order', g.sort_order,
           'reserved', (select count(*) from goodie_reservations r where r.goodie_id = g.id and r.status <> 'cancelled'),
           'collected', (select count(*) from goodie_reservations r where r.goodie_id = g.id and r.status = 'collected'))
         order by g.sort_order, g.name), '[]'::jsonb)
  from goodies g where g.event_id = p_event;
$$;

create or replace function admin_upsert_goodie(p_event uuid, p_id uuid, p_name text, p_description text, p_stock int,
                                               p_image_url text, p_is_active boolean, p_sort_order int, p_actor uuid)
returns jsonb language plpgsql as $$
declare v_taken int; v_id uuid; v_url text := nullif(btrim(coalesce(p_image_url, '')), '');
begin
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 80 then perform dx_raise('INVALID_INPUT', 'Name must be 1–80 characters'); end if;
  if p_stock is null or p_stock < 0 or p_stock > 100000 then perform dx_raise('INVALID_INPUT', 'Quantity must be between 0 and 100000'); end if;
  if v_url is not null and v_url !~ '^https://' then perform dx_raise('INVALID_INPUT', 'Image link must start with https://'); end if;
  if p_id is not null then
    perform 1 from goodies where id = p_id and event_id = p_event for update;
    if not found then perform dx_raise('NOT_FOUND', 'Goodie not found'); end if;
    select count(*) into v_taken from goodie_reservations where goodie_id = p_id and status <> 'cancelled';
    if p_stock < v_taken then
      perform dx_raise('INVALID_INPUT', v_taken || ' already reserved — quantity can''t go below that');
    end if;
    update goodies set name = btrim(p_name), description = nullif(btrim(coalesce(p_description, '')), ''), stock = p_stock,
           image_url = v_url, is_active = coalesce(p_is_active, is_active), sort_order = coalesce(p_sort_order, sort_order)
     where id = p_id returning id into v_id;
  else
    insert into goodies (event_id, name, description, stock, image_url, is_active, sort_order)
    values (p_event, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), p_stock, v_url, coalesce(p_is_active, true),
            coalesce(p_sort_order, (select coalesce(max(sort_order), 0) + 1 from goodies where event_id = p_event)))
    returning id into v_id;
  end if;
  perform dx_audit(p_event, 'admin', p_actor::text, case when p_id is null then 'goodie.created' else 'goodie.updated' end,
                   'goodie', v_id::text, null, jsonb_build_object('name', p_name, 'stock', p_stock, 'active', p_is_active));
  return jsonb_build_object('id', v_id);
end $$;

create or replace function admin_delete_goodie(p_event uuid, p_id uuid, p_actor uuid) returns void language plpgsql as $$
declare g goodies;
begin
  select * into g from goodies where id = p_id and event_id = p_event for update;
  if not found then perform dx_raise('NOT_FOUND', 'Goodie not found'); end if;
  if exists (select 1 from goodie_reservations where goodie_id = p_id) then
    perform dx_raise('INVALID_STATE', 'This goodie already has reservations — hide it instead of deleting');
  end if;
  delete from goodies where id = p_id;
  perform dx_audit(p_event, 'admin', p_actor::text, 'goodie.deleted', 'goodie', p_id::text, null, jsonb_build_object('name', g.name));
end $$;

-- Participants see the goodie image link.
create or replace function participant_arena_state(p_identity uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'participant', jsonb_build_object('name', h.participant_name, 'employee_id', h.employee_id, 'slot', 'P' || s.slot_number,
                                      'team_number', t.team_number, 'team_name', t.name, 'goodies_eligible', s.goodies_eligible),
    'goodies_open', e.goodies_open,
    'reservation', (select jsonb_build_object('goodie_id', r.goodie_id, 'name', g.name, 'status', r.status, 'reserved_at', r.reserved_at)
                    from goodie_reservations r join goodies g on g.id = r.goodie_id
                    where r.event_id = h.event_id and r.employee_id = h.employee_id),
    'goodies', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'description', g.description,
                           'image_url', g.image_url,
                           'remaining', g.stock - (select count(*) from goodie_reservations r where r.goodie_id = g.id and r.status <> 'cancelled'))
                         order by g.sort_order, g.name)
                         from goodies g where g.event_id = h.event_id and g.is_active), '[]'::jsonb))
  from participant_identity_history h
  join participant_slots s on s.id = h.slot_id join teams t on t.id = h.team_id join events e on e.id = h.event_id
  where h.id = p_identity;
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
