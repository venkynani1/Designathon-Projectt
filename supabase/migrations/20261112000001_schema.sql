-- =====================================================================
-- DESIGNATHON X — Permanent Credential & Registration System
-- Migration 1: schema, constraints, immutability guards, RLS
-- =====================================================================
-- Design rules enforced HERE (not only in application code):
--  * Team numbers, team/slot UUIDs and slot numbers are immutable; rows are never deleted.
--  * A team has at most 4 slots: slot_number ∈ {1..4} + UNIQUE(team_id, slot_number).
--  * PINs are stored only as Argon2id hashes + a keyed HMAC fingerprint
--    (fingerprint is UNIQUE per event => no PIN is ever reused in an event).
--  * A credential's hash can never be modified; it can only move
--    active -> compromised -> revoked (or active -> revoked) and be superseded by
--    a new version through the audited reissue workflow.
--  * One active employee identity per event; one problem assignment per team;
--    one goodie reservation per employee (permanent, never transferred).
--  * audit_logs is append-only.
-- =====================================================================

create type registration_source as enum ('pregenerated', 'online_import', 'walk_in', 'admin');
create type team_status        as enum ('unregistered', 'incomplete', 'registered', 'withdrawn');
create type slot_occupancy     as enum ('vacant', 'occupied');
create type credential_subject as enum ('team', 'slot');
create type credential_status  as enum ('active', 'compromised', 'revoked');
create type admin_role         as enum ('viewer', 'registrar', 'admin', 'superadmin');

-- ---------------------------------------------------------------------
create table events (
  id                    uuid primary key default gen_random_uuid(),
  code                  text not null unique check (code ~ '^[a-z0-9-]{2,40}$'),
  name                  text not null,
  tagline               text,
  venue                 text,
  brand_color           text not null default '#4338ca' check (brand_color ~ '^#[0-9a-fA-F]{6}$'),
  problems_qr_url       text,
  goodies_qr_url        text,
  allowed_email_domains text[],                       -- null = any corporate domain accepted
  problems_open         boolean not null default false,
  goodies_open          boolean not null default false,
  member_edits_frozen   boolean not null default false,
  package_ttl_hours     int not null default 72 check (package_ttl_hours between 1 and 168),
  created_at            timestamptz not null default now()
);

create table admin_users (
  user_id               uuid primary key references auth.users(id) on delete cascade,
  email                 text not null,
  display_name          text,
  role                  admin_role not null default 'viewer',
  can_issue_credentials boolean not null default false,
  created_at            timestamptz not null default now()
);

-- ---------------------------------------------------------------------
create table teams (
  id                  uuid primary key default gen_random_uuid(),
  event_id            uuid not null references events(id) on delete restrict,
  team_number         int  not null check (team_number between 1 and 9999),
  name                text check (name is null or char_length(name) between 2 and 60),
  registration_source registration_source not null default 'pregenerated',
  registration_status team_status not null default 'unregistered',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint teams_event_number_uq unique (event_id, team_number),
  constraint teams_id_event_uq unique (id, event_id)
);
create unique index teams_event_name_uq on teams (event_id, lower(name)) where name is not null;

-- ---------------------------------------------------------------------
create table participant_slots (
  id                  uuid primary key default gen_random_uuid(),
  event_id            uuid not null,
  team_id             uuid not null,
  slot_number         smallint not null check (slot_number between 1 and 4),
  occupancy           slot_occupancy not null default 'vacant',
  current_identity_id uuid,
  participant_name    text,
  employee_id         text,     -- normalized (upper, no whitespace)
  email               text,     -- normalized (lower)
  goodies_eligible    boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint slots_team_fk foreign key (team_id, event_id) references teams (id, event_id),
  constraint slots_team_slot_uq unique (team_id, slot_number),   -- P1..P4 exactly once => max 4 per team
  constraint slots_id_event_uq unique (id, event_id),
  constraint slots_occupancy_consistent check (
    (occupancy = 'occupied' and current_identity_id is not null and participant_name is not null and employee_id is not null)
    or (occupancy = 'vacant' and current_identity_id is null and participant_name is null and employee_id is null and email is null)
  )
);
create unique index slots_active_employee_uq on participant_slots (event_id, employee_id) where occupancy = 'occupied';
create unique index slots_active_email_uq    on participant_slots (event_id, email)       where occupancy = 'occupied' and email is not null;
create index slots_team_idx on participant_slots (team_id);

-- Every occupancy of a slot, ever. Never deleted.
create table participant_identity_history (
  id               uuid primary key default gen_random_uuid(),
  event_id         uuid not null,
  slot_id          uuid not null,
  team_id          uuid not null,
  employee_id      text not null,
  participant_name text not null,
  email            text,
  source           registration_source not null,
  assigned_at      timestamptz not null default now(),
  assigned_by      uuid,
  released_at      timestamptz,
  released_by      uuid,
  release_reason   text,
  constraint identity_slot_fk foreign key (slot_id, event_id) references participant_slots (id, event_id)
);
create unique index identity_active_employee_uq on participant_identity_history (event_id, employee_id) where released_at is null;
create unique index identity_active_slot_uq     on participant_identity_history (slot_id) where released_at is null;
create index identity_employee_idx on participant_identity_history (event_id, employee_id);

alter table participant_slots
  add constraint slots_current_identity_fk foreign key (current_identity_id)
  references participant_identity_history (id) deferrable initially deferred;

-- ---------------------------------------------------------------------
-- Temporary, encrypted (AES-256-GCM, key outside the DB) plaintext PIN packages
-- used only for controlled slip printing. Ciphertext is purged at expiry.
create table credential_packages (
  id                 uuid primary key,
  event_id           uuid not null references events(id),
  purpose            text not null check (purpose in ('initial', 'extension', 'reissue')),
  ciphertext         text,
  iv                 text,
  auth_tag           text,
  credential_count   int  not null check (credential_count > 0),
  created_by         uuid,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null,
  purged_at          timestamptz,
  download_count     int not null default 0,
  last_downloaded_at timestamptz,
  constraint packages_purged_consistent check ((purged_at is null) = (ciphertext is not null))
);

create table credential_records (
  id                uuid primary key,
  event_id          uuid not null references events(id),
  subject_type      credential_subject not null,
  team_id           uuid not null,
  slot_id           uuid,
  version           int  not null default 1 check (version >= 1),
  pin_hash          text not null check (pin_hash like '$argon2id$%'),
  pin_fingerprint   text not null check (char_length(pin_fingerprint) = 64),
  status            credential_status not null default 'active',
  package_id        uuid references credential_packages(id),
  issued_at         timestamptz not null default now(),
  issued_by         uuid,
  disclosed_at      timestamptz,             -- first time the plaintext left the system (slip printed)
  status_changed_at timestamptz,
  status_reason     text,
  constraint cred_subject_consistent check ((subject_type = 'slot') = (slot_id is not null)),
  constraint cred_team_fk foreign key (team_id, event_id) references teams (id, event_id),
  constraint cred_slot_fk foreign key (slot_id, event_id) references participant_slots (id, event_id)
);
-- No PIN value may ever be used twice in an event (team or slot, current or historical).
create unique index cred_event_fingerprint_uq on credential_records (event_id, pin_fingerprint);
-- Exactly one non-revoked credential per subject.
create unique index cred_team_current_uq on credential_records (team_id) where subject_type = 'team' and status <> 'revoked';
create unique index cred_slot_current_uq on credential_records (slot_id) where subject_type = 'slot' and status <> 'revoked';
create unique index cred_team_version_uq on credential_records (team_id, version) where subject_type = 'team';
create unique index cred_slot_version_uq on credential_records (slot_id, version) where subject_type = 'slot';
create index cred_package_idx on credential_records (package_id);

-- ---------------------------------------------------------------------
create table registration_imports (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references events(id),
  filename     text not null,
  format       text not null check (format in ('team', 'participant')),
  status       text not null default 'uploaded' check (status in ('uploaded', 'previewed', 'committed', 'failed')),
  headers      jsonb not null,
  raw_rows     jsonb not null,
  mapping      jsonb,
  plan         jsonb,
  summary      jsonb,
  errors       jsonb,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  committed_at timestamptz
);

-- ---------------------------------------------------------------------
-- Problem Statement Arena
create table problem_statements (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references events(id),
  code          text not null,
  title         text not null,
  summary       text,
  capacity      int  not null check (capacity > 0),
  document_path text,                       -- Supabase Storage path in bucket 'problem-docs'
  is_active     boolean not null default true,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  constraint problems_code_uq unique (event_id, code),
  constraint problems_id_event_uq unique (id, event_id)
);

create table problem_assignments (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null,
  team_id    uuid not null,
  problem_id uuid not null,
  session_id uuid,
  locked_at  timestamptz not null default now(),
  constraint assignment_one_per_team_uq unique (team_id),
  constraint assignment_team_fk foreign key (team_id, event_id) references teams (id, event_id),
  constraint assignment_problem_fk foreign key (problem_id, event_id) references problem_statements (id, event_id)
);
create index assignment_problem_idx on problem_assignments (problem_id);

-- Goodies Arena
create table goodies (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references events(id),
  name        text not null,
  description text,
  image_path  text,
  stock       int not null check (stock >= 0),
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  constraint goodies_id_event_uq unique (id, event_id)
);

create table goodie_reservations (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null,
  goodie_id    uuid not null,
  slot_id      uuid not null,
  identity_id  uuid not null references participant_identity_history(id),
  employee_id  text not null,
  status       text not null default 'reserved' check (status in ('reserved', 'collected', 'cancelled')),
  session_id   uuid,
  reserved_at  timestamptz not null default now(),
  collected_at timestamptz,
  constraint reservation_one_per_employee_uq unique (event_id, employee_id),   -- permanent, even if cancelled
  constraint reservation_one_per_identity_uq unique (identity_id),
  constraint reservation_goodie_fk foreign key (goodie_id, event_id) references goodies (id, event_id),
  constraint reservation_slot_fk foreign key (slot_id, event_id) references participant_slots (id, event_id)
);
create index reservation_goodie_idx on goodie_reservations (goodie_id);

-- ---------------------------------------------------------------------
-- Arena sessions (opaque random token in an httpOnly cookie; only SHA-256 stored)
create table arena_sessions (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references events(id),
  kind           text not null check (kind in ('team', 'participant')),
  token_hash     text not null unique check (char_length(token_hash) = 64),
  team_id        uuid not null references teams(id),
  slot_id        uuid references participant_slots(id),
  identity_id    uuid references participant_identity_history(id),
  credential_id  uuid not null references credential_records(id),
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  revoked_reason text,
  ip             text,
  user_agent     text,
  constraint session_kind_consistent check ((kind = 'participant') = (slot_id is not null and identity_id is not null))
);
create index sessions_team_idx on arena_sessions (team_id) where revoked_at is null;
create index sessions_slot_idx on arena_sessions (slot_id) where revoked_at is null;

-- Rate limiting ledger for PIN verification
create table auth_attempts (
  id           bigserial primary key,
  key          text not null,
  success      boolean not null,
  attempted_at timestamptz not null default now()
);
create index auth_attempts_key_time_idx on auth_attempts (key, attempted_at desc);

-- Append-only audit log
create table audit_logs (
  id          bigserial primary key,
  event_id    uuid,
  actor_type  text not null check (actor_type in ('admin', 'team', 'participant', 'system')),
  actor_id    text,
  action      text not null,
  entity_type text,
  entity_id   text,
  reason      text,
  details     jsonb,
  created_at  timestamptz not null default now()
);
create index audit_event_time_idx on audit_logs (event_id, created_at desc);
create index audit_entity_idx on audit_logs (entity_id);

-- =====================================================================
-- Immutability guards
-- =====================================================================
create or replace function dx_guard_teams() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'DX:IMMUTABLE:Teams are permanent and cannot be deleted';
  end if;
  if new.id <> old.id or new.event_id <> old.event_id or new.team_number <> old.team_number then
    raise exception using errcode = 'P0001', message = 'DX:IMMUTABLE:Team number and identifiers are permanent';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger teams_guard before update or delete on teams for each row execute function dx_guard_teams();

create or replace function dx_guard_slots() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'DX:IMMUTABLE:Participant slots are permanent and cannot be deleted';
  end if;
  if new.id <> old.id or new.event_id <> old.event_id or new.team_id <> old.team_id or new.slot_number <> old.slot_number then
    raise exception using errcode = 'P0001', message = 'DX:IMMUTABLE:Slot identifiers are permanent';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger slots_guard before update or delete on participant_slots for each row execute function dx_guard_slots();

create or replace function dx_guard_identity() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'DX:IMMUTABLE:Identity history is permanent';
  end if;
  if new.employee_id <> old.employee_id or new.slot_id <> old.slot_id or new.team_id <> old.team_id
     or new.event_id <> old.event_id or new.assigned_at <> old.assigned_at
     or (old.released_at is not null and new.released_at is distinct from old.released_at) then
    raise exception using errcode = 'P0001', message = 'DX:IMMUTABLE:Identity history records cannot be rewritten';
  end if;
  return new;
end $$;
create trigger identity_guard before update or delete on participant_identity_history for each row execute function dx_guard_identity();

create or replace function dx_guard_credentials() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'DX:IMMUTABLE:Credential records are permanent';
  end if;
  if new.id <> old.id or new.event_id <> old.event_id or new.subject_type <> old.subject_type
     or new.team_id <> old.team_id or new.slot_id is distinct from old.slot_id or new.version <> old.version
     or new.pin_hash <> old.pin_hash or new.pin_fingerprint <> old.pin_fingerprint
     or new.issued_at <> old.issued_at or new.package_id is distinct from old.package_id then
    raise exception using errcode = 'P0001', message = 'DX:IMMUTABLE:A credential can never be regenerated or altered';
  end if;
  if old.status = 'revoked' and new.status <> 'revoked' then
    raise exception using errcode = 'P0001', message = 'DX:IMMUTABLE:Revoked credentials cannot be reactivated';
  end if;
  if old.status = 'compromised' and new.status = 'active' then
    raise exception using errcode = 'P0001', message = 'DX:IMMUTABLE:Compromised credentials must be reissued, not reactivated';
  end if;
  if old.disclosed_at is not null and new.disclosed_at is distinct from old.disclosed_at then
    raise exception using errcode = 'P0001', message = 'DX:IMMUTABLE:Disclosure timestamp cannot be changed';
  end if;
  return new;
end $$;
create trigger credentials_guard before update or delete on credential_records for each row execute function dx_guard_credentials();

create or replace function dx_guard_reservations() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'DX:IMMUTABLE:Reservations are permanent records';
  end if;
  if new.identity_id <> old.identity_id or new.employee_id <> old.employee_id or new.slot_id <> old.slot_id
     or new.event_id <> old.event_id then
    raise exception using errcode = 'P0001', message = 'DX:IMMUTABLE:Reservations cannot be transferred to another participant';
  end if;
  return new;
end $$;
create trigger reservations_guard before update or delete on goodie_reservations for each row execute function dx_guard_reservations();

create or replace function dx_guard_assignments() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or new.team_id <> old.team_id or new.problem_id <> old.problem_id then
    raise exception using errcode = 'P0001', message = 'DX:IMMUTABLE:Problem assignments are locked';
  end if;
  return new;
end $$;
create trigger assignments_guard before update or delete on problem_assignments for each row execute function dx_guard_assignments();

create or replace function dx_guard_audit() returns trigger language plpgsql as $$
begin
  raise exception using errcode = 'P0001', message = 'DX:IMMUTABLE:Audit log is append-only';
end $$;
create trigger audit_guard before update or delete on audit_logs for each row execute function dx_guard_audit();

-- =====================================================================
-- Row Level Security: deny-by-default. Browsers never talk to these tables;
-- every read/write goes through server-side route handlers that authorize the
-- caller and then call SECURITY INVOKER functions with the service role.
-- =====================================================================
alter table events                       enable row level security;
alter table admin_users                  enable row level security;
alter table teams                        enable row level security;
alter table participant_slots            enable row level security;
alter table participant_identity_history enable row level security;
alter table credential_packages          enable row level security;
alter table credential_records           enable row level security;
alter table registration_imports         enable row level security;
alter table problem_statements           enable row level security;
alter table problem_assignments          enable row level security;
alter table goodies                      enable row level security;
alter table goodie_reservations          enable row level security;
alter table arena_sessions               enable row level security;
alter table auth_attempts                enable row level security;
alter table audit_logs                   enable row level security;

-- Admins may read their own admin record (used only for UI hints).
create policy admin_users_self_read on admin_users for select to authenticated using (user_id = auth.uid());

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select on admin_users to authenticated;
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;
