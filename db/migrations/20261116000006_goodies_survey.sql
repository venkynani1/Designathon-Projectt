-- =====================================================================
-- Pre-event goodies survey: one shared link/QR, no PIN.
-- Participants enter employee ID + name, pick one goodie, submit.
-- Organizer uploads a photo per goodie and downloads a report.
-- =====================================================================

-- Photos live in the database (small, resized in the browser) so no extra storage service is needed.
alter table goodies add column if not exists image_version int not null default 0;

create table if not exists goodie_images (
  goodie_id  uuid primary key references goodies(id) on delete cascade,
  mime       text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  data       bytea not null check (octet_length(data) between 1 and 600000),
  updated_at timestamptz not null default now()
);

create table if not exists goodie_choices (
  id               uuid primary key default gen_random_uuid(),
  event_id         uuid not null references events(id),
  goodie_id        uuid not null,
  employee_id      text not null check (employee_id ~ '^[A-Z0-9._/-]{2,40}$'),
  participant_name text not null check (char_length(participant_name) between 2 and 100),
  slot_id          uuid,                 -- registered participant matched by employee ID at the time of choosing (may be null)
  created_at       timestamptz not null default now(),
  constraint choice_one_per_employee_uq unique (event_id, employee_id),
  constraint choice_goodie_fk foreign key (goodie_id, event_id) references goodies (id, event_id)
);
create index if not exists choice_goodie_idx on goodie_choices (goodie_id);

alter table goodie_images  enable row level security;
alter table goodie_choices enable row level security;
drop policy if exists server_all on goodie_images;
drop policy if exists server_all on goodie_choices;
create policy server_all on goodie_images  for all to service_role using (true) with check (true);
create policy server_all on goodie_choices for all to service_role using (true) with check (true);
grant select, insert, update, delete on goodie_images, goodie_choices to service_role;

-- Everything that consumes stock: arena reservations (legacy) + survey choices.
create or replace function dx_goodie_taken(p_goodie uuid) returns int language sql stable as $$
  select ((select count(*) from goodie_reservations r where r.goodie_id = p_goodie and r.status <> 'cancelled')
        + (select count(*) from goodie_choices c where c.goodie_id = p_goodie))::int;
$$;

create or replace function dx_goodie_image(g goodies) returns text language sql stable as $$
  select case when g.image_version > 0 then '/api/survey/image/' || g.id || '?v=' || g.image_version else g.image_url end;
$$;

create or replace function dx_norm_employee(p text) returns text language sql immutable as $$
  select upper(regexp_replace(coalesce(p, ''), '\s', '', 'g'));
$$;

-- The survey runs before the event, so opening it must NOT freeze registration edits any more.
create or replace function dx_assert_identity_change_allowed(p_event uuid, p_privileged boolean, p_reason text)
returns boolean language plpgsql stable as $$
declare e events;
begin
  select * into e from events where id = p_event;
  if not found then perform dx_raise('NOT_FOUND', 'Event not found'); end if;
  if e.member_edits_frozen then
    if not coalesce(p_privileged, false) then
      perform dx_raise('FROZEN', 'Participant changes are frozen. Use the privileged exception workflow with a reason.');
    end if;
    if char_length(btrim(coalesce(p_reason, ''))) < 10 then
      perform dx_raise('REASON_REQUIRED', 'A reason of at least 10 characters is required for a privileged change');
    end if;
    return true;
  end if;
  return false;
end $$;

create or replace function set_event_flags(p_event uuid, p_flags jsonb, p_actor uuid) returns jsonb language plpgsql as $$
declare e events;
begin
  update events set
    problems_open       = coalesce((p_flags ->> 'problems_open')::boolean, problems_open),
    goodies_open        = coalesce((p_flags ->> 'goodies_open')::boolean, goodies_open),
    member_edits_frozen = coalesce((p_flags ->> 'member_edits_frozen')::boolean, member_edits_frozen)
  where id = p_event returning * into e;
  if not found then perform dx_raise('NOT_FOUND', 'Event not found'); end if;
  perform dx_audit(p_event, 'admin', p_actor::text, 'event.flags_changed', 'event', p_event::text, null, p_flags);
  return jsonb_build_object('problems_open', e.problems_open, 'goodies_open', e.goodies_open, 'member_edits_frozen', e.member_edits_frozen);
end $$;

create or replace function import_context(p_event uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'teams', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'team_number', t.team_number, 'name', t.name,
                         'status', t.registration_status,
                         'occupied', (select count(*) from participant_slots s where s.team_id = t.id and s.occupancy = 'occupied'))
                       order by t.team_number) from teams t where t.event_id = p_event), '[]'::jsonb),
    'employee_ids', coalesce((select jsonb_agg(employee_id) from participant_slots where event_id = p_event and occupancy = 'occupied'), '[]'::jsonb),
    'emails', coalesce((select jsonb_agg(email) from participant_slots where event_id = p_event and occupancy = 'occupied' and email is not null), '[]'::jsonb),
    'frozen', (select member_edits_frozen from events where id = p_event)
  );
$$;

-- ---------------------------------------------------------------------
-- Public survey
-- ---------------------------------------------------------------------
create or replace function survey_feed(p_event uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'event', e.name,
    'open', e.goodies_open,
    'goodies', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', g.id, 'name', g.name, 'description', g.description, 'stock', g.stock,
                  'left', greatest(g.stock - dx_goodie_taken(g.id), 0), 'image', dx_goodie_image(g))
                order by g.sort_order, g.name)
                from goodies g where g.event_id = e.id and g.is_active), '[]'::jsonb),
    'at', now())
  from events e where e.id = p_event;
$$;

create or replace function survey_submit(p_event uuid, p_employee_id text, p_name text, p_goodie uuid) returns jsonb
language plpgsql as $$
declare e events; g goodies; v_emp text := dx_norm_employee(p_employee_id);
        v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_prev text; v_slot uuid;
begin
  select * into e from events where id = p_event;
  if not found then perform dx_raise('NOT_FOUND', 'Event not found'); end if;
  if not e.goodies_open then perform dx_raise('ARENA_CLOSED', 'The goodies survey is closed right now'); end if;
  if v_emp !~ '^[A-Z0-9._/-]{2,40}$' then perform dx_raise('INVALID_INPUT', 'Enter a valid employee ID'); end if;
  if char_length(v_name) not between 2 and 100 then perform dx_raise('INVALID_INPUT', 'Enter your full name'); end if;

  -- one choice per employee ID (survey or legacy arena)
  select g2.name into v_prev from goodie_choices c join goodies g2 on g2.id = c.goodie_id
   where c.event_id = p_event and c.employee_id = v_emp;
  if v_prev is null then
    select g2.name into v_prev from goodie_reservations r join goodies g2 on g2.id = r.goodie_id
     where r.event_id = p_event and r.employee_id = v_emp and r.status <> 'cancelled';
  end if;
  if v_prev is not null then
    perform dx_raise('ALREADY_RESERVED', 'Employee ID ' || v_emp || ' has already chosen: ' || v_prev);
  end if;

  -- lock the goodie row: concurrent picks of the same goodie queue here, so stock can never go negative
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

create or replace function get_goodie_image(p_goodie uuid) returns jsonb language sql stable as $$
  select jsonb_build_object('mime', mime, 'data', encode(data, 'base64')) from goodie_images where goodie_id = p_goodie;
$$;

-- ---------------------------------------------------------------------
-- Organizer
-- ---------------------------------------------------------------------
create or replace function admin_set_goodie_image(p_event uuid, p_id uuid, p_mime text, p_data_b64 text, p_actor uuid)
returns jsonb language plpgsql as $$
declare v_ver int;
begin
  perform 1 from goodies where id = p_id and event_id = p_event for update;
  if not found then perform dx_raise('NOT_FOUND', 'Goodie not found'); end if;
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp') then perform dx_raise('INVALID_INPUT', 'Photo must be JPEG, PNG or WebP'); end if;
  if p_data_b64 is null or length(p_data_b64) > 800000 then perform dx_raise('INVALID_INPUT', 'Photo is too large'); end if;
  insert into goodie_images (goodie_id, mime, data, updated_at) values (p_id, p_mime, decode(p_data_b64, 'base64'), now())
  on conflict (goodie_id) do update set mime = excluded.mime, data = excluded.data, updated_at = now();
  update goodies set image_version = image_version + 1, image_url = null where id = p_id returning image_version into v_ver;
  perform dx_audit(p_event, 'admin', p_actor::text, 'goodie.photo_updated', 'goodie', p_id::text, null, null);
  return jsonb_build_object('image_version', v_ver);
end $$;

create or replace function admin_remove_goodie_image(p_event uuid, p_id uuid, p_actor uuid) returns void language plpgsql as $$
begin
  perform 1 from goodies where id = p_id and event_id = p_event for update;
  if not found then perform dx_raise('NOT_FOUND', 'Goodie not found'); end if;
  delete from goodie_images where goodie_id = p_id;
  update goodies set image_version = 0, image_url = null where id = p_id;
  perform dx_audit(p_event, 'admin', p_actor::text, 'goodie.photo_removed', 'goodie', p_id::text, null, null);
end $$;

create or replace function admin_list_goodies(p_event uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', g.id, 'name', g.name, 'description', g.description, 'stock', g.stock, 'image_url', dx_goodie_image(g),
           'has_photo', g.image_version > 0, 'is_active', g.is_active, 'sort_order', g.sort_order,
           'reserved', dx_goodie_taken(g.id),
           'chosen', (select count(*) from goodie_choices c where c.goodie_id = g.id),
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
    v_taken := dx_goodie_taken(p_id);
    if p_stock < v_taken then
      perform dx_raise('INVALID_INPUT', v_taken || ' already chosen — quantity can''t go below that');
    end if;
    -- an uploaded photo wins over a link; only replace the link when no photo is uploaded
    update goodies set name = btrim(p_name), description = nullif(btrim(coalesce(p_description, '')), ''), stock = p_stock,
           image_url = case when image_version > 0 then null else v_url end,
           is_active = coalesce(p_is_active, is_active), sort_order = coalesce(p_sort_order, sort_order)
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
  if exists (select 1 from goodie_reservations where goodie_id = p_id) or exists (select 1 from goodie_choices where goodie_id = p_id) then
    perform dx_raise('INVALID_STATE', 'People have already chosen this goodie — hide it instead of deleting');
  end if;
  delete from goodies where id = p_id;
  perform dx_audit(p_event, 'admin', p_actor::text, 'goodie.deleted', 'goodie', p_id::text, null, jsonb_build_object('name', g.name));
end $$;

-- Responses + registered participants who haven't answered yet.
create or replace function admin_survey_report(p_event uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'choices', coalesce((select jsonb_agg(jsonb_build_object(
                  'employee_id', c.employee_id, 'name', c.participant_name, 'goodie', g.name, 'chosen_at', c.created_at,
                  'registered', s.id is not null, 'registered_name', s.participant_name, 'email', s.email,
                  'team_number', t.team_number, 'team_name', t.name)
                order by c.created_at desc)
                from goodie_choices c join goodies g on g.id = c.goodie_id
                left join participant_slots s on s.event_id = c.event_id and s.occupancy = 'occupied' and s.employee_id = c.employee_id
                left join teams t on t.id = s.team_id
                where c.event_id = p_event), '[]'::jsonb),
    'pending', coalesce((select jsonb_agg(jsonb_build_object(
                  'employee_id', s.employee_id, 'name', s.participant_name, 'email', s.email,
                  'team_number', t.team_number, 'team_name', t.name)
                order by t.team_number, s.slot_number)
                from participant_slots s join teams t on t.id = s.team_id
                where s.event_id = p_event and s.occupancy = 'occupied'
                  and not exists (select 1 from goodie_choices c where c.event_id = p_event and c.employee_id = s.employee_id)), '[]'::jsonb),
    'goodies', admin_list_goodies(p_event));
$$;

create or replace function admin_reset_choice(p_event uuid, p_employee_id text, p_actor uuid) returns void language plpgsql as $$
declare v_emp text := dx_norm_employee(p_employee_id); v_goodie text;
begin
  delete from goodie_choices c using goodies g
   where c.event_id = p_event and c.employee_id = v_emp and g.id = c.goodie_id returning g.name into v_goodie;
  if v_goodie is null then perform dx_raise('NOT_FOUND', 'No choice found for ' || v_emp); end if;
  perform dx_audit(p_event, 'admin', p_actor::text, 'goodie.choice_reset', 'goodie_choice', v_emp, null,
                   jsonb_build_object('employee_id', v_emp, 'goodie', v_goodie));
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
