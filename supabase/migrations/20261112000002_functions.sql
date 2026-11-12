-- =====================================================================
-- DESIGNATHON X — Migration 2: transactional business functions
-- Every sensitive change is a single PostgreSQL function call => one transaction.
-- Errors are raised as 'DX:<CODE>:<message>' and mapped to HTTP codes by the API.
-- Execute permission: service_role only (see bottom of file).
-- =====================================================================

-- ---------------------------------------------------------------- helpers
create or replace function dx_raise(p_code text, p_msg text) returns void language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = 'DX:' || p_code || ':' || p_msg;
end $$;

create or replace function dx_norm_emp(p text) returns text language sql immutable as $$
  select nullif(upper(regexp_replace(coalesce(p, ''), '\s+', '', 'g')), '')
$$;

create or replace function dx_norm_email(p text) returns text language sql immutable as $$
  select nullif(lower(btrim(coalesce(p, ''))), '')
$$;

create or replace function dx_team_label(p_number int) returns text language sql immutable as $$
  select 'Team ' || lpad(p_number::text, 3, '0')
$$;

create or replace function dx_audit(p_event uuid, p_actor_type text, p_actor_id text, p_action text,
                                    p_entity_type text, p_entity_id text, p_reason text, p_details jsonb)
returns void language sql as $$
  insert into audit_logs (event_id, actor_type, actor_id, action, entity_type, entity_id, reason, details)
  values (p_event, p_actor_type, p_actor_id, p_action, p_entity_type, p_entity_id, p_reason, p_details);
$$;

create or replace function dx_clean_member(p_event uuid, m jsonb) returns jsonb language plpgsql stable as $$
declare
  v_name  text := btrim(regexp_replace(coalesce(m ->> 'name', ''), '\s+', ' ', 'g'));
  v_emp   text := dx_norm_emp(m ->> 'employee_id');
  v_email text := dx_norm_email(m ->> 'email');
  v_domains text[];
begin
  if char_length(v_name) < 1 or char_length(v_name) > 120 then
    perform dx_raise('INVALID_MEMBER', 'Participant name is required (max 120 characters)');
  end if;
  if v_emp is null or v_emp !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$' then
    perform dx_raise('INVALID_MEMBER', 'Invalid employee ID "' || coalesce(m ->> 'employee_id', '') || '" for ' || v_name);
  end if;
  if v_email is not null then
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      perform dx_raise('INVALID_MEMBER', 'Invalid email for ' || v_name);
    end if;
    select allowed_email_domains into v_domains from events where id = p_event;
    if v_domains is not null and array_length(v_domains, 1) > 0
       and not (split_part(v_email, '@', 2) = any (v_domains)) then
      perform dx_raise('INVALID_MEMBER', 'Email domain not allowed for ' || v_name);
    end if;
  end if;
  return jsonb_build_object('name', v_name, 'employee_id', v_emp, 'email', v_email);
end $$;

create or replace function dx_refresh_team_status(p_team uuid) returns int language plpgsql as $$
declare n int;
begin
  select count(*) into n from participant_slots where team_id = p_team and occupancy = 'occupied';
  update teams
     set registration_status = (case when n = 0 then 'unregistered' when n = 1 then 'incomplete' else 'registered' end)::team_status
   where id = p_team and registration_status <> 'withdrawn'
     and registration_status is distinct from (case when n = 0 then 'unregistered' when n = 1 then 'incomplete' else 'registered' end)::team_status;
  return n;
end $$;

-- Identity changes (add / remove / replace / employee-id change) are frozen once
-- the Goodies Arena opens, or when the admin freezes edits. A privileged path exists.
create or replace function dx_assert_identity_change_allowed(p_event uuid, p_privileged boolean, p_reason text)
returns boolean language plpgsql stable as $$
declare e events;
begin
  select * into e from events where id = p_event;
  if not found then perform dx_raise('NOT_FOUND', 'Event not found'); end if;
  if e.goodies_open or e.member_edits_frozen then
    if not coalesce(p_privileged, false) then
      perform dx_raise('FROZEN', 'Participant changes are frozen. Use the privileged exception workflow with a reason.');
    end if;
    if char_length(btrim(coalesce(p_reason, ''))) < 10 then
      perform dx_raise('REASON_REQUIRED', 'A reason of at least 10 characters is required for a privileged change');
    end if;
    return true;   -- frozen, privileged
  end if;
  return false;
end $$;

create or replace function dx_lock_team(p_event uuid, p_team uuid) returns teams language plpgsql as $$
declare t teams;
begin
  select * into t from teams where id = p_team and event_id = p_event for update;
  if not found then perform dx_raise('NOT_FOUND', 'Team not found'); end if;
  return t;
end $$;

create or replace function dx_set_team_name(p_team uuid, p_name text) returns text language plpgsql as $$
declare v text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  if char_length(v) < 2 or char_length(v) > 60 then
    perform dx_raise('INVALID_NAME', 'Team name must be 2–60 characters');
  end if;
  begin
    update teams set name = v where id = p_team;
  exception when unique_violation then
    perform dx_raise('DUPLICATE_TEAM_NAME', 'Another team already uses the name "' || v || '"');
  end;
  return v;
end $$;

-- Places a cleaned member into a specific vacant slot. Never touches credentials.
create or replace function dx_assign_slot(p_slot uuid, p_member jsonb, p_source registration_source, p_actor uuid)
returns jsonb language plpgsql as $$
declare s participant_slots; v_hid uuid; v_cred credential_records;
begin
  select * into s from participant_slots where id = p_slot for update;
  if s.occupancy <> 'vacant' then
    perform dx_raise('SLOT_OCCUPIED', 'Slot P' || s.slot_number || ' is already occupied');
  end if;
  begin
    insert into participant_identity_history (event_id, slot_id, team_id, employee_id, participant_name, email, source, assigned_by)
    values (s.event_id, s.id, s.team_id, p_member ->> 'employee_id', p_member ->> 'name', p_member ->> 'email', p_source, p_actor)
    returning id into v_hid;
    update participant_slots
       set occupancy = 'occupied', current_identity_id = v_hid, participant_name = p_member ->> 'name',
           employee_id = p_member ->> 'employee_id', email = p_member ->> 'email', goodies_eligible = true
     where id = s.id;
  exception when unique_violation then
    perform dx_raise('DUPLICATE_EMPLOYEE', 'Employee ID ' || (p_member ->> 'employee_id')
      || coalesce(' / email ' || (p_member ->> 'email'), '') || ' is already registered in this event');
  end;
  select * into v_cred from credential_records where slot_id = s.id and status <> 'revoked';
  return jsonb_build_object('slot_id', s.id, 'slot_number', s.slot_number, 'identity_id', v_hid,
                            'credential_status', v_cred.status,
                            'requires_reissue', v_cred.status = 'compromised');
end $$;

-- Releases the occupant of a slot. Keeps the slot, its credential and the
-- identity history. If the slot PIN was already disclosed, the credential is
-- flagged 'compromised' so the former occupant's knowledge grants nothing.
create or replace function dx_release_slot(p_slot uuid, p_reason text, p_actor uuid) returns jsonb language plpgsql as $$
declare s participant_slots; v_compromised boolean := false;
begin
  select * into s from participant_slots where id = p_slot for update;
  if s.occupancy <> 'occupied' then perform dx_raise('NOT_OCCUPIED', 'Slot P' || s.slot_number || ' is already vacant'); end if;

  update participant_identity_history
     set released_at = now(), released_by = p_actor, release_reason = coalesce(nullif(btrim(p_reason), ''), 'Removed by administrator')
   where id = s.current_identity_id;

  update participant_slots
     set occupancy = 'vacant', current_identity_id = null, participant_name = null, employee_id = null, email = null
   where id = s.id;

  update credential_records
     set status = 'compromised', status_changed_at = now(),
         status_reason = 'Slot PIN was disclosed to former occupant ' || s.employee_id || '; secure reissue required'
   where slot_id = s.id and status = 'active' and disclosed_at is not null;
  v_compromised := found;

  update arena_sessions set revoked_at = now(), revoked_reason = 'slot_occupant_changed'
   where slot_id = s.id and revoked_at is null;

  return jsonb_build_object('slot_id', s.id, 'slot_number', s.slot_number, 'released_employee_id', s.employee_id,
                            'released_identity_id', s.current_identity_id, 'credential_compromised', v_compromised);
end $$;

-- Registers members into an EMPTY team (walk-in or import). P1..Pn in source order.
create or replace function dx_register_team(p_event uuid, p_team uuid, p_name text, p_members jsonb,
                                            p_source registration_source, p_actor uuid)
returns jsonb language plpgsql as $$
declare t teams; n int; i int; v_sid uuid; v_res jsonb := '[]'::jsonb; v_clean jsonb; v_name text;
begin
  t := dx_lock_team(p_event, p_team);
  if t.registration_status = 'withdrawn' then perform dx_raise('TEAM_WITHDRAWN', dx_team_label(t.team_number) || ' is withdrawn'); end if;
  select count(*) into n from participant_slots where team_id = t.id and occupancy = 'occupied';
  if n > 0 then
    perform dx_raise('TEAM_NOT_EMPTY', dx_team_label(t.team_number) || ' already has registered participants; edit it instead of overwriting');
  end if;
  if jsonb_typeof(p_members) <> 'array' or jsonb_array_length(p_members) not between 2 and 4 then
    perform dx_raise('TEAM_SIZE', 'A team must have 2–4 participants');
  end if;
  if (select count(distinct dx_norm_emp(x ->> 'employee_id')) from jsonb_array_elements(p_members) x) <> jsonb_array_length(p_members) then
    perform dx_raise('DUPLICATE_EMPLOYEE', 'The same employee ID appears twice in ' || dx_team_label(t.team_number));
  end if;

  v_name := dx_set_team_name(t.id, coalesce(nullif(btrim(coalesce(p_name, '')), ''), coalesce(t.name, dx_team_label(t.team_number))));
  update teams set registration_source = p_source where id = t.id;

  for i in 0 .. jsonb_array_length(p_members) - 1 loop
    v_clean := dx_clean_member(p_event, p_members -> i);
    select id into v_sid from participant_slots where team_id = t.id and slot_number = i + 1;
    v_res := v_res || jsonb_build_array(dx_assign_slot(v_sid, v_clean, p_source, p_actor) || jsonb_build_object('name', v_clean ->> 'name'));
  end loop;
  perform dx_refresh_team_status(t.id);
  return jsonb_build_object('team_id', t.id, 'team_number', t.team_number, 'name', v_name, 'slots', v_res);
end $$;

-- =====================================================================
-- Provisioning: batch-create numbered teams + 4 slots + 5 credentials each,
-- plus the encrypted printable package — all in one transaction.
-- PINs are generated, hashed and encrypted in the application tier; the
-- database never sees plaintext.
-- p_teams: [{team_id, team_credential:{id,hash,fingerprint}, slots:[{slot_id, slot_number, credential:{...}} x4]}]
-- p_package: {id, purpose, ciphertext, iv, auth_tag, expires_at}
-- =====================================================================
create or replace function provision_teams(p_event uuid, p_teams jsonb, p_package jsonb, p_actor uuid)
returns jsonb language plpgsql as $$
declare v_next int; v_team jsonb; v_slot jsonb; v_out jsonb := '[]'::jsonb; v_count int;
begin
  if not exists (select 1 from events where id = p_event) then perform dx_raise('NOT_FOUND', 'Event not found'); end if;
  if jsonb_typeof(p_teams) <> 'array' or jsonb_array_length(p_teams) not between 1 and 500 then
    perform dx_raise('INVALID_INPUT', 'Provision between 1 and 500 teams at a time');
  end if;
  -- serialize numbering per event; numbers are never reused because teams are never deleted
  perform pg_advisory_xact_lock(hashtextextended('dx-provision:' || p_event::text, 0));
  select coalesce(max(team_number), 0) + 1 into v_next from teams where event_id = p_event;
  if v_next + jsonb_array_length(p_teams) - 1 > 9999 then perform dx_raise('INVALID_INPUT', 'Team number limit reached'); end if;

  v_count := jsonb_array_length(p_teams) * 5;
  insert into credential_packages (id, event_id, purpose, ciphertext, iv, auth_tag, credential_count, created_by, expires_at)
  values ((p_package ->> 'id')::uuid, p_event, p_package ->> 'purpose', p_package ->> 'ciphertext', p_package ->> 'iv',
          p_package ->> 'auth_tag', v_count, p_actor, (p_package ->> 'expires_at')::timestamptz);

  for v_team in select * from jsonb_array_elements(p_teams) loop
    if jsonb_array_length(v_team -> 'slots') <> 4 then perform dx_raise('INVALID_INPUT', 'Each team needs exactly 4 slots'); end if;
    insert into teams (id, event_id, team_number) values ((v_team ->> 'team_id')::uuid, p_event, v_next);
    insert into credential_records (id, event_id, subject_type, team_id, pin_hash, pin_fingerprint, package_id, issued_by)
    values ((v_team -> 'team_credential' ->> 'id')::uuid, p_event, 'team', (v_team ->> 'team_id')::uuid,
            v_team -> 'team_credential' ->> 'hash', v_team -> 'team_credential' ->> 'fingerprint', (p_package ->> 'id')::uuid, p_actor);
    for v_slot in select * from jsonb_array_elements(v_team -> 'slots') loop
      insert into participant_slots (id, event_id, team_id, slot_number)
      values ((v_slot ->> 'slot_id')::uuid, p_event, (v_team ->> 'team_id')::uuid, (v_slot ->> 'slot_number')::smallint);
      insert into credential_records (id, event_id, subject_type, team_id, slot_id, pin_hash, pin_fingerprint, package_id, issued_by)
      values ((v_slot -> 'credential' ->> 'id')::uuid, p_event, 'slot', (v_team ->> 'team_id')::uuid, (v_slot ->> 'slot_id')::uuid,
              v_slot -> 'credential' ->> 'hash', v_slot -> 'credential' ->> 'fingerprint', (p_package ->> 'id')::uuid, p_actor);
    end loop;
    v_out := v_out || jsonb_build_array(jsonb_build_object('team_id', v_team ->> 'team_id', 'team_number', v_next));
    v_next := v_next + 1;
  end loop;

  perform dx_audit(p_event, 'admin', p_actor::text, 'teams.provisioned', 'credential_package', p_package ->> 'id', null,
                   jsonb_build_object('count', jsonb_array_length(p_teams),
                                      'first', (v_out -> 0 ->> 'team_number')::int, 'last', v_next - 1));
  return jsonb_build_object('package_id', p_package ->> 'id', 'teams', v_out);
exception when unique_violation then
  -- fingerprint collision with an existing PIN (astronomically rare after app-side pre-check): caller retries
  perform dx_raise('PIN_COLLISION', 'Generated credential collided with an existing one; retry');
end $$;

create or replace function event_pin_fingerprints(p_event uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(pin_fingerprint), '[]'::jsonb) from credential_records where event_id = p_event;
$$;

-- =====================================================================
-- Registration workflows
-- =====================================================================
create or replace function register_walk_in(p_event uuid, p_team uuid, p_name text, p_members jsonb, p_actor uuid,
                                            p_privileged boolean default false, p_reason text default null)
returns jsonb language plpgsql as $$
declare v_frozen boolean; v_res jsonb;
begin
  v_frozen := dx_assert_identity_change_allowed(p_event, p_privileged, p_reason);
  v_res := dx_register_team(p_event, p_team, p_name, p_members, 'walk_in', p_actor);
  perform dx_audit(p_event, 'admin', p_actor::text, case when v_frozen then 'team.walk_in_registered.privileged' else 'team.walk_in_registered' end,
                   'team', p_team::text, p_reason, v_res);
  return v_res;
end $$;

create or replace function rename_team(p_event uuid, p_team uuid, p_name text, p_actor uuid) returns jsonb language plpgsql as $$
declare t teams; v_name text;
begin
  t := dx_lock_team(p_event, p_team);
  v_name := dx_set_team_name(t.id, p_name);
  perform dx_audit(p_event, 'admin', p_actor::text, 'team.renamed', 'team', t.id::text, null,
                   jsonb_build_object('team_number', t.team_number, 'from', t.name, 'to', v_name));
  return jsonb_build_object('team_id', t.id, 'team_number', t.team_number, 'name', v_name);
end $$;

-- Adds a member to the FIRST vacant slot in numerical order. Occupied slots never move.
create or replace function add_member(p_event uuid, p_team uuid, p_member jsonb, p_actor uuid,
                                      p_privileged boolean default false, p_reason text default null)
returns jsonb language plpgsql as $$
declare t teams; v_frozen boolean; v_sid uuid; v_res jsonb; v_clean jsonb;
begin
  v_frozen := dx_assert_identity_change_allowed(p_event, p_privileged, p_reason);
  t := dx_lock_team(p_event, p_team);
  if t.registration_status = 'withdrawn' then perform dx_raise('TEAM_WITHDRAWN', 'Team is withdrawn'); end if;
  select id into v_sid from participant_slots where team_id = t.id and occupancy = 'vacant' order by slot_number limit 1;
  if v_sid is null then perform dx_raise('TEAM_FULL', dx_team_label(t.team_number) || ' already has 4 participants'); end if;
  v_clean := dx_clean_member(p_event, p_member);
  v_res := dx_assign_slot(v_sid, v_clean, 'admin', p_actor);
  if t.registration_source = 'pregenerated' then update teams set registration_source = 'admin' where id = t.id; end if;
  if t.name is null then perform dx_set_team_name(t.id, dx_team_label(t.team_number)); end if;
  perform dx_refresh_team_status(t.id);
  perform dx_audit(p_event, 'admin', p_actor::text, case when v_frozen then 'member.added.privileged' else 'member.added' end,
                   'slot', v_sid::text, p_reason, v_res || jsonb_build_object('employee_id', v_clean ->> 'employee_id', 'team_number', t.team_number));
  return v_res;
end $$;

create or replace function remove_member(p_event uuid, p_slot uuid, p_reason text, p_actor uuid,
                                         p_privileged boolean default false)
returns jsonb language plpgsql as $$
declare v_frozen boolean; s participant_slots; t teams; v_res jsonb;
begin
  v_frozen := dx_assert_identity_change_allowed(p_event, p_privileged, p_reason);
  select * into s from participant_slots where id = p_slot and event_id = p_event;
  if not found then perform dx_raise('NOT_FOUND', 'Slot not found'); end if;
  t := dx_lock_team(p_event, s.team_id);
  v_res := dx_release_slot(s.id, p_reason, p_actor);
  perform dx_refresh_team_status(t.id);
  perform dx_audit(p_event, 'admin', p_actor::text, case when v_frozen then 'member.removed.privileged' else 'member.removed' end,
                   'slot', s.id::text, p_reason, v_res || jsonb_build_object('team_number', t.team_number));
  return v_res;
end $$;

-- Replaces the occupant of a slot with a different employee (also used to correct an employee ID).
-- The former participant's reservation stays with the former participant (never transferred).
create or replace function replace_member(p_event uuid, p_slot uuid, p_member jsonb, p_reason text, p_actor uuid,
                                          p_privileged boolean default false)
returns jsonb language plpgsql as $$
declare v_frozen boolean; s participant_slots; t teams; v_rel jsonb; v_asg jsonb; v_clean jsonb; v_had_res boolean;
begin
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then
    perform dx_raise('REASON_REQUIRED', 'A reason of at least 10 characters is required to replace a participant');
  end if;
  v_frozen := dx_assert_identity_change_allowed(p_event, p_privileged, p_reason);
  select * into s from participant_slots where id = p_slot and event_id = p_event;
  if not found then perform dx_raise('NOT_FOUND', 'Slot not found'); end if;
  t := dx_lock_team(p_event, s.team_id);
  v_clean := dx_clean_member(p_event, p_member);
  if s.occupancy = 'occupied' and s.employee_id = v_clean ->> 'employee_id' then
    perform dx_raise('INVALID_INPUT', 'Same employee — use "Edit details" instead of replacement');
  end if;
  select exists (select 1 from goodie_reservations where identity_id = s.current_identity_id) into v_had_res;
  if s.occupancy = 'occupied' then v_rel := dx_release_slot(s.id, p_reason, p_actor); end if;
  v_asg := dx_assign_slot(s.id, v_clean, 'admin', p_actor);
  perform dx_refresh_team_status(t.id);
  perform dx_audit(p_event, 'admin', p_actor::text, case when v_frozen then 'member.replaced.privileged' else 'member.replaced' end,
                   'slot', s.id::text, p_reason,
                   jsonb_build_object('team_number', t.team_number, 'slot_number', s.slot_number, 'released', v_rel,
                                      'assigned', v_asg, 'new_employee_id', v_clean ->> 'employee_id',
                                      'former_participant_kept_reservation', coalesce(v_had_res, false)));
  return jsonb_build_object('released', v_rel, 'assigned', v_asg,
                            'requires_reissue', coalesce((v_asg ->> 'requires_reissue')::boolean, false));
end $$;

-- Name / email corrections for the SAME employee. Never touches credentials or reservations.
create or replace function update_member_details(p_event uuid, p_slot uuid, p_name text, p_email text, p_actor uuid)
returns jsonb language plpgsql as $$
declare s participant_slots; v_clean jsonb;
begin
  select * into s from participant_slots where id = p_slot and event_id = p_event for update;
  if not found then perform dx_raise('NOT_FOUND', 'Slot not found'); end if;
  if s.occupancy <> 'occupied' then perform dx_raise('NOT_OCCUPIED', 'Slot is vacant — use "Add member"'); end if;
  v_clean := dx_clean_member(p_event, jsonb_build_object('name', p_name, 'employee_id', s.employee_id, 'email', p_email));
  begin
    update participant_slots set participant_name = v_clean ->> 'name', email = v_clean ->> 'email' where id = s.id;
  exception when unique_violation then
    perform dx_raise('DUPLICATE_EMPLOYEE', 'That email is already registered to another participant');
  end;
  update participant_identity_history set participant_name = v_clean ->> 'name', email = v_clean ->> 'email'
   where id = s.current_identity_id;
  perform dx_audit(p_event, 'admin', p_actor::text, 'member.details_updated', 'slot', s.id::text, null,
                   jsonb_build_object('from', jsonb_build_object('name', s.participant_name, 'email', s.email),
                                      'to', jsonb_build_object('name', v_clean ->> 'name', 'email', v_clean ->> 'email')));
  return jsonb_build_object('slot_id', s.id, 'name', v_clean ->> 'name', 'email', v_clean ->> 'email');
end $$;

create or replace function set_goodies_eligibility(p_event uuid, p_slot uuid, p_eligible boolean, p_reason text, p_actor uuid)
returns jsonb language plpgsql as $$
begin
  update participant_slots set goodies_eligible = p_eligible where id = p_slot and event_id = p_event;
  if not found then perform dx_raise('NOT_FOUND', 'Slot not found'); end if;
  perform dx_audit(p_event, 'admin', p_actor::text, 'member.goodies_eligibility', 'slot', p_slot::text, p_reason,
                   jsonb_build_object('eligible', p_eligible));
  return jsonb_build_object('slot_id', p_slot, 'goodies_eligible', p_eligible);
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
  -- Opening the Goodies Arena freezes identity changes by default.
  if (p_flags ->> 'goodies_open')::boolean is true and not e.member_edits_frozen then
    update events set member_edits_frozen = true where id = p_event returning * into e;
  end if;
  perform dx_audit(p_event, 'admin', p_actor::text, 'event.flags_changed', 'event', p_event::text, null, p_flags);
  return jsonb_build_object('problems_open', e.problems_open, 'goodies_open', e.goodies_open, 'member_edits_frozen', e.member_edits_frozen);
end $$;

-- =====================================================================
-- Import (preview stored server-side; commit re-validates in one transaction)
-- =====================================================================
create or replace function import_context(p_event uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'teams', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'team_number', t.team_number, 'name', t.name,
                         'status', t.registration_status,
                         'occupied', (select count(*) from participant_slots s where s.team_id = t.id and s.occupancy = 'occupied'))
                       order by t.team_number) from teams t where t.event_id = p_event), '[]'::jsonb),
    'employee_ids', coalesce((select jsonb_agg(employee_id) from participant_slots where event_id = p_event and occupancy = 'occupied'), '[]'::jsonb),
    'emails', coalesce((select jsonb_agg(email) from participant_slots where event_id = p_event and occupancy = 'occupied' and email is not null), '[]'::jsonb),
    'frozen', (select goodies_open or member_edits_frozen from events where id = p_event)
  );
$$;

create or replace function create_import(p_event uuid, p_filename text, p_format text, p_headers jsonb, p_rows jsonb, p_actor uuid)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into registration_imports (event_id, filename, format, headers, raw_rows, created_by)
  values (p_event, p_filename, p_format, p_headers, p_rows, p_actor) returning id into v_id;
  perform dx_audit(p_event, 'admin', p_actor::text, 'import.uploaded', 'import', v_id::text, null,
                   jsonb_build_object('filename', p_filename, 'rows', jsonb_array_length(p_rows)));
  return v_id;
end $$;

create or replace function get_import(p_event uuid, p_import uuid) returns jsonb language sql stable as $$
  select to_jsonb(i) from registration_imports i where i.id = p_import and i.event_id = p_event;
$$;

create or replace function list_imports(p_event uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'filename', filename, 'format', format, 'status', status,
                  'summary', summary, 'created_at', created_at, 'committed_at', committed_at) order by created_at desc), '[]'::jsonb)
  from registration_imports where event_id = p_event;
$$;

create or replace function save_import_preview(p_event uuid, p_import uuid, p_mapping jsonb, p_plan jsonb, p_summary jsonb, p_errors jsonb)
returns void language plpgsql as $$
begin
  update registration_imports set mapping = p_mapping, plan = p_plan, summary = p_summary, errors = p_errors, status = 'previewed'
   where id = p_import and event_id = p_event and status in ('uploaded', 'previewed');
  if not found then perform dx_raise('INVALID_STATE', 'Import not found or already committed'); end if;
end $$;

create or replace function commit_import(p_event uuid, p_import uuid, p_actor uuid,
                                         p_privileged boolean default false, p_reason text default null)
returns jsonb language plpgsql as $$
declare i registration_imports; v_team jsonb; v_res jsonb := '[]'::jsonb; v_frozen boolean;
begin
  select * into i from registration_imports where id = p_import and event_id = p_event for update;
  if not found then perform dx_raise('NOT_FOUND', 'Import not found'); end if;
  if i.status <> 'previewed' then perform dx_raise('INVALID_STATE', 'Import must be previewed before commit (status: ' || i.status || ')'); end if;
  if jsonb_array_length(coalesce(i.errors, '[]'::jsonb)) > 0 then
    perform dx_raise('IMPORT_HAS_ERRORS', 'Resolve all validation errors before committing');
  end if;
  v_frozen := dx_assert_identity_change_allowed(p_event, p_privileged, p_reason);
  for v_team in select * from jsonb_array_elements(i.plan -> 'teams') loop
    v_res := v_res || jsonb_build_array(
      dx_register_team(p_event, (v_team ->> 'team_id')::uuid, v_team ->> 'team_name', v_team -> 'members', 'online_import', p_actor));
  end loop;
  update registration_imports set status = 'committed', committed_at = now(),
         summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object('committed_teams', jsonb_array_length(v_res))
   where id = i.id;
  perform dx_audit(p_event, 'admin', p_actor::text, 'import.committed', 'import', i.id::text, p_reason,
                   jsonb_build_object('teams', jsonb_array_length(v_res), 'filename', i.filename));
  return jsonb_build_object('import_id', i.id, 'teams', v_res);
end $$;

-- =====================================================================
-- Credential packages & reissuance
-- =====================================================================
create or replace function list_packages(p_event uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'purpose', p.purpose, 'credential_count', p.credential_count,
           'created_at', p.created_at, 'expires_at', p.expires_at, 'purged_at', p.purged_at,
           'available', p.purged_at is null and p.expires_at > now(),
           'download_count', p.download_count, 'last_downloaded_at', p.last_downloaded_at,
           'team_numbers', (select jsonb_agg(distinct t.team_number) from credential_records c join teams t on t.id = c.team_id where c.package_id = p.id))
         order by p.created_at desc), '[]'::jsonb)
  from credential_packages p where p.event_id = p_event;
$$;

create or replace function package_for_render(p_event uuid, p_package uuid) returns jsonb language plpgsql stable as $$
declare p credential_packages;
begin
  select * into p from credential_packages where id = p_package and event_id = p_event;
  if not found then perform dx_raise('NOT_FOUND', 'Credential package not found'); end if;
  if p.purged_at is not null or p.expires_at <= now() then
    perform dx_raise('PACKAGE_EXPIRED', 'This credential package has expired and its PINs were destroyed. PINs cannot be recovered from hashes — use the supervised reissue workflow.');
  end if;
  return jsonb_build_object(
    'package', jsonb_build_object('id', p.id, 'purpose', p.purpose, 'ciphertext', p.ciphertext, 'iv', p.iv,
                                  'auth_tag', p.auth_tag, 'expires_at', p.expires_at, 'created_at', p.created_at),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'credential_id', c.id, 'subject_type', c.subject_type, 'status', c.status, 'version', c.version,
        'team_id', t.id, 'team_number', t.team_number, 'team_name', t.name,
        'slot_number', s.slot_number, 'participant_name', s.participant_name, 'employee_id', s.employee_id)
        order by t.team_number, c.subject_type, s.slot_number)
      from credential_records c join teams t on t.id = c.team_id left join participant_slots s on s.id = c.slot_id
      where c.package_id = p.id), '[]'::jsonb));
end $$;

-- Everything needed to print slips for a set of teams (null = all), without secrets.
create or replace function slip_data(p_event uuid, p_team_ids uuid[]) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'team_id', t.id, 'team_number', t.team_number, 'team_name', t.name, 'registration_status', t.registration_status,
    'team_credential', (select jsonb_build_object('id', c.id, 'status', c.status, 'package_id', c.package_id, 'version', c.version)
                        from credential_records c where c.team_id = t.id and c.subject_type = 'team' and c.status <> 'revoked'),
    'slots', (select jsonb_agg(jsonb_build_object('slot_number', s.slot_number, 'participant_name', s.participant_name,
                 'employee_id', s.employee_id,
                 'credential', (select jsonb_build_object('id', c.id, 'status', c.status, 'package_id', c.package_id, 'version', c.version)
                                from credential_records c where c.slot_id = s.id and c.status <> 'revoked'))
               order by s.slot_number) from participant_slots s where s.team_id = t.id))
    order by t.team_number), '[]'::jsonb)
  from teams t where t.event_id = p_event and (p_team_ids is null or t.id = any (p_team_ids));
$$;

-- Returns the encrypted payload of packages that are still within their issuance window.
create or replace function package_secrets(p_event uuid, p_packages uuid[]) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'ciphertext', ciphertext, 'iv', iv, 'auth_tag', auth_tag)), '[]'::jsonb)
  from credential_packages
  where event_id = p_event and id = any (p_packages) and purged_at is null and expires_at > now();
$$;

-- Records that plaintext PINs left the system (slip printed). Drives the
-- "compromised on replacement" rule.
create or replace function mark_credentials_disclosed(p_event uuid, p_credentials uuid[], p_actor uuid, p_context jsonb)
returns int language plpgsql as $$
declare n int;
begin
  update credential_records set disclosed_at = now()
   where event_id = p_event and id = any (p_credentials) and disclosed_at is null and status = 'active';
  get diagnostics n = row_count;
  update credential_packages set download_count = download_count + 1, last_downloaded_at = now()
   where id in (select distinct package_id from credential_records where id = any (p_credentials));
  perform dx_audit(p_event, 'admin', p_actor::text, 'credentials.slips_printed', 'credentials', null, null,
                   coalesce(p_context, '{}'::jsonb) || jsonb_build_object('credentials', coalesce(array_length(p_credentials, 1), 0), 'newly_disclosed', n));
  return n;
end $$;

create or replace function purge_package(p_event uuid, p_package uuid, p_actor uuid) returns void language plpgsql as $$
begin
  update credential_packages set ciphertext = null, iv = null, auth_tag = null, purged_at = now()
   where id = p_package and event_id = p_event and purged_at is null;
  perform dx_audit(p_event, 'admin', p_actor::text, 'credentials.package_purged', 'credential_package', p_package::text, null, null);
end $$;

create or replace function purge_expired_packages() returns int language plpgsql as $$
declare n int;
begin
  update credential_packages set ciphertext = null, iv = null, auth_tag = null, purged_at = now()
   where purged_at is null and expires_at <= now();
  get diagnostics n = row_count;
  delete from auth_attempts where attempted_at < now() - interval '2 days';
  update arena_sessions set revoked_at = now(), revoked_reason = 'expired' where revoked_at is null and expires_at <= now();
  if n > 0 then perform dx_audit(null, 'system', 'cron', 'credentials.packages_expired', null, null, null, jsonb_build_object('purged', n)); end if;
  return n;
end $$;

-- Supervised reissue: the ONLY way a PIN value ever changes. Old credential is
-- revoked (kept for history), a new version is issued, sessions are invalidated.
-- p_items: [{old_credential_id, new:{id, hash, fingerprint}}]
create or replace function reissue_credentials(p_event uuid, p_items jsonb, p_package jsonb, p_reason text, p_actor uuid)
returns jsonb language plpgsql as $$
declare v_item jsonb; o credential_records; v_out jsonb := '[]'::jsonb;
begin
  if char_length(btrim(coalesce(p_reason, ''))) < 10 then
    perform dx_raise('REASON_REQUIRED', 'A reason of at least 10 characters is required to reissue credentials');
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then perform dx_raise('INVALID_INPUT', 'Nothing to reissue'); end if;
  insert into credential_packages (id, event_id, purpose, ciphertext, iv, auth_tag, credential_count, created_by, expires_at)
  values ((p_package ->> 'id')::uuid, p_event, 'reissue', p_package ->> 'ciphertext', p_package ->> 'iv', p_package ->> 'auth_tag',
          jsonb_array_length(p_items), p_actor, (p_package ->> 'expires_at')::timestamptz);
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into o from credential_records where id = (v_item ->> 'old_credential_id')::uuid and event_id = p_event for update;
    if not found then perform dx_raise('NOT_FOUND', 'Credential not found'); end if;
    if o.status = 'revoked' then perform dx_raise('INVALID_STATE', 'Credential already revoked'); end if;
    update credential_records set status = 'revoked', status_changed_at = now(), status_reason = 'Reissued: ' || p_reason where id = o.id;
    insert into credential_records (id, event_id, subject_type, team_id, slot_id, version, pin_hash, pin_fingerprint, package_id, issued_by)
    values ((v_item -> 'new' ->> 'id')::uuid, p_event, o.subject_type, o.team_id, o.slot_id, o.version + 1,
            v_item -> 'new' ->> 'hash', v_item -> 'new' ->> 'fingerprint', (p_package ->> 'id')::uuid, p_actor);
    if o.subject_type = 'team' then
      update arena_sessions set revoked_at = now(), revoked_reason = 'credential_reissued' where team_id = o.team_id and kind = 'team' and revoked_at is null;
    else
      update arena_sessions set revoked_at = now(), revoked_reason = 'credential_reissued' where slot_id = o.slot_id and revoked_at is null;
    end if;
    perform dx_audit(p_event, 'admin', p_actor::text, 'credential.reissued', 'credential', o.id::text, p_reason,
                     jsonb_build_object('subject_type', o.subject_type, 'team_id', o.team_id, 'slot_id', o.slot_id,
                                        'old_version', o.version, 'new_version', o.version + 1, 'previous_status', o.status,
                                        'new_credential_id', v_item -> 'new' ->> 'id'));
    v_out := v_out || jsonb_build_array(jsonb_build_object('old', o.id, 'new', v_item -> 'new' ->> 'id', 'version', o.version + 1));
  end loop;
  return jsonb_build_object('package_id', p_package ->> 'id', 'reissued', v_out);
exception when unique_violation then
  perform dx_raise('PIN_COLLISION', 'Generated credential collided with an existing one; retry');
end $$;

create or replace function current_credentials_for_team(p_event uuid, p_team uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('credential_id', c.id, 'subject_type', c.subject_type, 'slot_number', s.slot_number,
                  'status', c.status, 'version', c.version, 'disclosed_at', c.disclosed_at,
                  'package_available', p.purged_at is null and p.expires_at > now(), 'package_id', c.package_id)
                  order by c.subject_type, s.slot_number), '[]'::jsonb)
  from credential_records c left join participant_slots s on s.id = c.slot_id left join credential_packages p on p.id = c.package_id
  where c.event_id = p_event and c.team_id = p_team and c.status <> 'revoked';
$$;

-- =====================================================================
-- Rate limiting
-- =====================================================================
-- Returns seconds until retry is allowed (0 = allowed). Counts only failures.
create or replace function rl_retry_after(p_key text, p_max int, p_window_seconds int) returns int language plpgsql stable as $$
declare n int; v_oldest timestamptz;
begin
  select count(*), min(attempted_at) into n, v_oldest from (
    select attempted_at from auth_attempts
     where key = p_key and success = false and attempted_at > now() - make_interval(secs => p_window_seconds)
     order by attempted_at desc limit p_max) x;
  if n < p_max then return 0; end if;
  return greatest(1, ceil(extract(epoch from (v_oldest + make_interval(secs => p_window_seconds) - now())))::int);
end $$;

create or replace function rl_record(p_keys text[], p_success boolean) returns void language sql as $$
  insert into auth_attempts (key, success) select k, p_success from unnest(p_keys) k;
$$;

-- =====================================================================
-- Arena authentication & sessions
-- =====================================================================
create or replace function get_event(p_code text) returns jsonb language sql stable as $$
  select to_jsonb(e) from events e where e.code = p_code;
$$;

create or replace function arena_team_directory(p_event uuid, p_q text) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('team_number', team_number, 'name', name) order by team_number), '[]'::jsonb)
  from (select team_number, name from teams
         where event_id = p_event and registration_status = 'registered'
           and (coalesce(p_q, '') = ''
                or lpad(team_number::text, 3, '0') like '%' || regexp_replace(p_q, '[^0-9]', '', 'g') || '%' and p_q ~ '[0-9]'
                or name ilike '%' || replace(replace(replace(p_q, '\', '\\'), '%', '\%'), '_', '\_') || '%')
         order by team_number limit 15) x;
$$;

create or replace function get_team_login(p_event uuid, p_team_number int) returns jsonb language sql stable as $$
  select jsonb_build_object('team_id', t.id, 'team_number', t.team_number, 'name', t.name, 'status', t.registration_status,
                            'credential_id', c.id, 'credential_status', c.status, 'pin_hash', c.pin_hash)
  from teams t left join credential_records c on c.team_id = t.id and c.subject_type = 'team' and c.status <> 'revoked'
  where t.event_id = p_event and t.team_number = p_team_number;
$$;

create or replace function get_participant_login(p_event uuid, p_employee_id text) returns jsonb language sql stable as $$
  select jsonb_build_object('slot_id', s.id, 'team_id', s.team_id, 'identity_id', s.current_identity_id,
                            'name', s.participant_name, 'slot_number', s.slot_number, 'goodies_eligible', s.goodies_eligible,
                            'team_status', t.registration_status,
                            'credential_id', c.id, 'credential_status', c.status, 'pin_hash', c.pin_hash)
  from participant_slots s join teams t on t.id = s.team_id
  left join credential_records c on c.slot_id = s.id and c.status <> 'revoked'
  where s.event_id = p_event and s.occupancy = 'occupied' and s.employee_id = dx_norm_emp(p_employee_id);
$$;

create or replace function create_arena_session(p_event uuid, p_kind text, p_token_hash text, p_team uuid, p_slot uuid,
                                                p_identity uuid, p_credential uuid, p_ttl_minutes int, p_ip text, p_ua text)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into arena_sessions (event_id, kind, token_hash, team_id, slot_id, identity_id, credential_id, expires_at, ip, user_agent)
  values (p_event, p_kind, p_token_hash, p_team, p_slot, p_identity, p_credential,
          now() + make_interval(mins => p_ttl_minutes), left(p_ip, 64), left(p_ua, 300))
  returning id into v_id;
  perform dx_audit(p_event, p_kind, coalesce(p_identity, p_team)::text, p_kind || '.login', p_kind, coalesce(p_slot, p_team)::text, null,
                   jsonb_build_object('session_id', v_id, 'ip', p_ip));
  return v_id;
end $$;

-- Validates a session on EVERY request: not expired/revoked, credential still
-- active, and for participants the slot is still held by the same identity.
create or replace function resolve_arena_session(p_token_hash text, p_kind text) returns jsonb language plpgsql as $$
declare ss arena_sessions; v_cred credential_status; s participant_slots; t teams; v_bad text;
begin
  select * into ss from arena_sessions where token_hash = p_token_hash and kind = p_kind and revoked_at is null and expires_at > now();
  if not found then return null; end if;
  select status into v_cred from credential_records where id = ss.credential_id;
  select * into t from teams where id = ss.team_id;
  if v_cred <> 'active' then v_bad := 'credential_' || v_cred::text; end if;
  if p_kind = 'participant' then
    select * into s from participant_slots where id = ss.slot_id;
    if s.occupancy <> 'occupied' or s.current_identity_id is distinct from ss.identity_id then v_bad := 'slot_occupant_changed'; end if;
  elsif t.registration_status <> 'registered' then
    v_bad := 'team_not_eligible';
  end if;
  if v_bad is not null then
    update arena_sessions set revoked_at = now(), revoked_reason = v_bad where id = ss.id;
    return null;
  end if;
  update arena_sessions set last_seen_at = now() where id = ss.id and last_seen_at < now() - interval '1 minute';
  return jsonb_build_object('session_id', ss.id, 'event_id', ss.event_id, 'team_id', ss.team_id,
                            'slot_id', ss.slot_id, 'identity_id', ss.identity_id);
end $$;

create or replace function revoke_arena_session(p_token_hash text) returns void language sql as $$
  update arena_sessions set revoked_at = now(), revoked_reason = 'logout' where token_hash = p_token_hash and revoked_at is null;
$$;

-- =====================================================================
-- Problem Statement Arena
-- =====================================================================
create or replace function team_arena_state(p_team uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'team', jsonb_build_object('id', t.id, 'team_number', t.team_number, 'name', t.name, 'status', t.registration_status),
    'members', coalesce((select jsonb_agg(jsonb_build_object('slot', 'P' || s.slot_number, 'name', s.participant_name) order by s.slot_number)
                         from participant_slots s where s.team_id = t.id and s.occupancy = 'occupied'), '[]'::jsonb),
    'problems_open', e.problems_open,
    'assignment', (select jsonb_build_object('problem_id', a.problem_id, 'code', p.code, 'title', p.title, 'locked_at', a.locked_at)
                   from problem_assignments a join problem_statements p on p.id = a.problem_id where a.team_id = t.id),
    'problems', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'code', p.code, 'title', p.title, 'summary', p.summary,
                            'capacity', p.capacity, 'document_path', p.document_path,
                            'remaining', p.capacity - (select count(*) from problem_assignments a where a.problem_id = p.id))
                          order by p.sort_order, p.code)
                          from problem_statements p where p.event_id = t.event_id and p.is_active), '[]'::jsonb))
  from teams t join events e on e.id = t.event_id where t.id = p_team;
$$;

create or replace function lock_problem(p_team uuid, p_problem uuid, p_session uuid) returns jsonb language plpgsql as $$
declare t teams; e events; p problem_statements; v_used int;
begin
  -- Lock order: team row, then problem row => no deadlocks, teammates serialize on the team row,
  -- competing teams serialize on the problem row (capacity is re-counted after the lock).
  select * into t from teams where id = p_team for update;
  if not found then perform dx_raise('NOT_FOUND', 'Team not found'); end if;
  select * into e from events where id = t.event_id;
  if not e.problems_open then perform dx_raise('ARENA_CLOSED', 'Problem statement selection is not open'); end if;
  if t.registration_status <> 'registered' then perform dx_raise('TEAM_NOT_ELIGIBLE', 'A team needs 2–4 registered participants to select a problem'); end if;
  if exists (select 1 from problem_assignments where team_id = t.id) then
    perform dx_raise('ALREADY_ASSIGNED', 'Your team has already locked a problem statement');
  end if;
  select * into p from problem_statements where id = p_problem and event_id = t.event_id and is_active for update;
  if not found then perform dx_raise('NOT_FOUND', 'Problem statement not found'); end if;
  select count(*) into v_used from problem_assignments where problem_id = p.id;
  if v_used >= p.capacity then perform dx_raise('PROBLEM_FULL', p.code || ' has no remaining slots'); end if;
  insert into problem_assignments (event_id, team_id, problem_id, session_id) values (t.event_id, t.id, p.id, p_session);
  perform dx_audit(t.event_id, 'team', t.id::text, 'problem.locked', 'problem', p.id::text, null,
                   jsonb_build_object('team_number', t.team_number, 'code', p.code, 'session_id', p_session));
  return team_arena_state(t.id);
end $$;

-- =====================================================================
-- Goodies Arena
-- =====================================================================
create or replace function participant_arena_state(p_identity uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'participant', jsonb_build_object('name', h.participant_name, 'employee_id', h.employee_id, 'slot', 'P' || s.slot_number,
                                      'team_number', t.team_number, 'team_name', t.name, 'goodies_eligible', s.goodies_eligible),
    'goodies_open', e.goodies_open,
    'reservation', (select jsonb_build_object('goodie_id', r.goodie_id, 'name', g.name, 'status', r.status, 'reserved_at', r.reserved_at)
                    from goodie_reservations r join goodies g on g.id = r.goodie_id
                    where r.event_id = h.event_id and r.employee_id = h.employee_id),
    'goodies', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'description', g.description,
                           'image_path', g.image_path,
                           'remaining', g.stock - (select count(*) from goodie_reservations r where r.goodie_id = g.id and r.status <> 'cancelled'))
                         order by g.sort_order, g.name)
                         from goodies g where g.event_id = h.event_id and g.is_active), '[]'::jsonb))
  from participant_identity_history h
  join participant_slots s on s.id = h.slot_id join teams t on t.id = h.team_id join events e on e.id = h.event_id
  where h.id = p_identity;
$$;

create or replace function reserve_goodie(p_identity uuid, p_goodie uuid, p_session uuid) returns jsonb language plpgsql as $$
declare h participant_identity_history; s participant_slots; e events; g goodies; v_used int;
begin
  select * into h from participant_identity_history where id = p_identity;
  if not found then perform dx_raise('NOT_FOUND', 'Participant not found'); end if;
  -- serialize all attempts by this participant on their slot row
  select * into s from participant_slots where id = h.slot_id for update;
  if s.current_identity_id is distinct from h.id then perform dx_raise('SESSION_INVALID', 'You are no longer registered in this slot'); end if;
  select * into e from events where id = h.event_id;
  if not e.goodies_open then perform dx_raise('ARENA_CLOSED', 'Goodies reservation is not open'); end if;
  if not s.goodies_eligible then perform dx_raise('NOT_ELIGIBLE', 'You are not eligible for goodies'); end if;
  if exists (select 1 from goodie_reservations where event_id = h.event_id and employee_id = h.employee_id) then
    perform dx_raise('ALREADY_RESERVED', 'You have already reserved a goodie');
  end if;
  select * into g from goodies where id = p_goodie and event_id = h.event_id and is_active for update;
  if not found then perform dx_raise('NOT_FOUND', 'Goodie not found'); end if;
  select count(*) into v_used from goodie_reservations where goodie_id = g.id and status <> 'cancelled';
  if v_used >= g.stock then perform dx_raise('OUT_OF_STOCK', g.name || ' is out of stock'); end if;
  begin
    insert into goodie_reservations (event_id, goodie_id, slot_id, identity_id, employee_id, session_id)
    values (h.event_id, g.id, s.id, h.id, h.employee_id, p_session);
  exception when unique_violation then
    perform dx_raise('ALREADY_RESERVED', 'You have already reserved a goodie');
  end;
  perform dx_audit(h.event_id, 'participant', h.id::text, 'goodie.reserved', 'goodie', g.id::text, null,
                   jsonb_build_object('employee_id', h.employee_id, 'goodie', g.name, 'session_id', p_session));
  return participant_arena_state(h.id);
end $$;

-- =====================================================================
-- Admin read models (never return hashes or fingerprints)
-- =====================================================================
create or replace function get_admin_user(p_user uuid) returns jsonb language sql stable as $$
  select jsonb_build_object('user_id', user_id, 'email', email, 'display_name', display_name, 'role', role,
                            'can_issue_credentials', can_issue_credentials)
  from admin_users where user_id = p_user;
$$;

create or replace function admin_list_teams(p_event uuid, p_q text) returns jsonb language plpgsql stable as $$
declare v_q text := btrim(coalesce(p_q, '')); v_like text; v_digits text;
begin
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_digits := nullif(regexp_replace(v_q, '[^0-9]', '', 'g'), '');
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.team_number) from (
    select t.id, t.team_number, t.name, t.registration_source, t.registration_status,
      (select count(*) from participant_slots s where s.team_id = t.id and s.occupancy = 'occupied') as occupied,
      (select jsonb_build_object('code', p.code, 'title', p.title) from problem_assignments a
         join problem_statements p on p.id = a.problem_id where a.team_id = t.id) as assignment,
      (select count(*) from goodie_reservations r join participant_slots s on s.current_identity_id = r.identity_id
         where s.team_id = t.id and r.status <> 'cancelled') as reservations,
      (select count(*) from credential_records c where c.team_id = t.id and c.status = 'compromised') as compromised,
      (select count(*) from credential_records c where c.team_id = t.id and c.status = 'active' and c.disclosed_at is null) as undisclosed
    from teams t
    where t.event_id = p_event and (
      v_q = ''
      or (v_digits is not null and v_q ~ '^\s*(team\s*)?#?\s*[0-9]+\s*$' and t.team_number = v_digits::int)
      or t.name ilike v_like
      or exists (select 1 from participant_slots s where s.team_id = t.id and s.occupancy = 'occupied'
                   and (s.participant_name ilike v_like or s.employee_id ilike v_like or s.email ilike v_like))
    )) x), '[]'::jsonb);
end $$;

create or replace function admin_team_detail(p_event uuid, p_team uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'team', jsonb_build_object('id', t.id, 'team_number', t.team_number, 'name', t.name, 'registration_source', t.registration_source,
                               'registration_status', t.registration_status, 'created_at', t.created_at, 'updated_at', t.updated_at),
    'team_credential', (select jsonb_build_object('id', c.id, 'status', c.status, 'version', c.version, 'disclosed_at', c.disclosed_at,
                          'issued_at', c.issued_at, 'status_reason', c.status_reason)
                        from credential_records c where c.team_id = t.id and c.subject_type = 'team' and c.status <> 'revoked'),
    'slots', (select jsonb_agg(jsonb_build_object(
                 'id', s.id, 'slot_number', s.slot_number, 'occupancy', s.occupancy, 'participant_name', s.participant_name,
                 'employee_id', s.employee_id, 'email', s.email, 'goodies_eligible', s.goodies_eligible,
                 'credential', (select jsonb_build_object('id', c.id, 'status', c.status, 'version', c.version, 'disclosed_at', c.disclosed_at,
                                  'issued_at', c.issued_at, 'status_reason', c.status_reason)
                                from credential_records c where c.slot_id = s.id and c.status <> 'revoked'),
                 'reservation', (select jsonb_build_object('goodie', g.name, 'status', r.status, 'reserved_at', r.reserved_at)
                                 from goodie_reservations r join goodies g on g.id = r.goodie_id where r.identity_id = s.current_identity_id),
                 'history', (select coalesce(jsonb_agg(jsonb_build_object('participant_name', h.participant_name, 'employee_id', h.employee_id,
                                 'source', h.source, 'assigned_at', h.assigned_at, 'released_at', h.released_at, 'release_reason', h.release_reason,
                                 'reservation', (select g.name from goodie_reservations r join goodies g on g.id = r.goodie_id where r.identity_id = h.id))
                               order by h.assigned_at), '[]'::jsonb)
                             from participant_identity_history h where h.slot_id = s.id))
               order by s.slot_number) from participant_slots s where s.team_id = t.id),
    'assignment', (select jsonb_build_object('code', p.code, 'title', p.title, 'locked_at', a.locked_at)
                   from problem_assignments a join problem_statements p on p.id = a.problem_id where a.team_id = t.id))
  from teams t where t.id = p_team and t.event_id = p_event;
$$;

create or replace function admin_event_summary(p_event uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'event', jsonb_build_object('id', e.id, 'code', e.code, 'name', e.name, 'problems_open', e.problems_open,
                                'goodies_open', e.goodies_open, 'member_edits_frozen', e.member_edits_frozen,
                                'package_ttl_hours', e.package_ttl_hours),
    'teams_total',        (select count(*) from teams where event_id = e.id),
    'teams_registered',   (select count(*) from teams where event_id = e.id and registration_status = 'registered'),
    'teams_incomplete',   (select count(*) from teams where event_id = e.id and registration_status = 'incomplete'),
    'teams_unregistered', (select count(*) from teams where event_id = e.id and registration_status = 'unregistered'),
    'slots_occupied',     (select count(*) from participant_slots where event_id = e.id and occupancy = 'occupied'),
    'slots_vacant',       (select count(*) from participant_slots where event_id = e.id and occupancy = 'vacant'),
    'assignments',        (select count(*) from problem_assignments where event_id = e.id),
    'reservations',       (select count(*) from goodie_reservations where event_id = e.id and status <> 'cancelled'),
    'credentials_compromised', (select count(*) from credential_records where event_id = e.id and status = 'compromised'),
    'credentials_undisclosed', (select count(*) from credential_records where event_id = e.id and status = 'active' and disclosed_at is null),
    'packages_available', (select count(*) from credential_packages where event_id = e.id and purged_at is null and expires_at > now()))
  from events e where e.id = p_event;
$$;

create or replace function admin_report_rows(p_event uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'team_number', t.team_number, 'team_name', t.name, 'registration_source', t.registration_source,
    'registration_status', t.registration_status,
    'assignment', (select p.code || ' — ' || p.title from problem_assignments a join problem_statements p on p.id = a.problem_id where a.team_id = t.id),
    'slots', (select jsonb_agg(jsonb_build_object('slot_number', s.slot_number, 'name', s.participant_name, 'employee_id', s.employee_id,
                 'reservation', (select g.name || ' (' || r.status || ')' from goodie_reservations r join goodies g on g.id = r.goodie_id
                                 where r.identity_id = s.current_identity_id))
               order by s.slot_number) from participant_slots s where s.team_id = t.id))
    order by t.team_number), '[]'::jsonb)
  from teams t where t.event_id = p_event;
$$;

create or replace function admin_audit(p_event uuid, p_entity text, p_limit int) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(a) order by a.id desc), '[]'::jsonb) from (
    select id, actor_type, actor_id, action, entity_type, entity_id, reason, details, created_at
    from audit_logs
    where (event_id = p_event or event_id is null)
      and (p_entity is null or entity_id = p_entity or details::text like '%' || p_entity || '%')
    order by id desc limit least(greatest(coalesce(p_limit, 200), 1), 1000)) a;
$$;

-- =====================================================================
-- Permissions: only the server (service_role) may execute anything.
-- =====================================================================
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
