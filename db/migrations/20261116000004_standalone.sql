-- =====================================================================
-- DESIGNATHON X — Migration 4: standalone operation (no Supabase required)
--  * Built-in admin accounts: Argon2id password hashes + revocable server sessions
--  * Problem statement documents as links (Drive/SharePoint/etc.)
--  * Explicit row-level policies for the server role (hosts without BYPASSRLS)
-- =====================================================================

-- ---------------------------------------------------------------- admins
alter table admin_users drop constraint if exists admin_users_user_id_fkey;
alter table admin_users alter column user_id set default gen_random_uuid();
alter table admin_users
  add column if not exists password_hash text,
  add column if not exists is_active boolean not null default true,
  add column if not exists last_login_at timestamptz;
alter table admin_users drop constraint if exists admin_users_password_hash_chk;
alter table admin_users add constraint admin_users_password_hash_chk check (password_hash is null or password_hash like '$argon2id$%');
create unique index if not exists admin_users_email_uq on admin_users (lower(email));

create table if not exists admin_sessions (
  id         uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (char_length(token_hash) = 64),
  user_id    uuid not null references admin_users(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip         text,
  user_agent text
);
create index if not exists admin_sessions_user_idx on admin_sessions (user_id) where revoked_at is null;
alter table admin_sessions enable row level security;
revoke all on admin_sessions from anon, authenticated;
grant all on admin_sessions to service_role;

-- --------------------------------------------------------- problem docs
alter table problem_statements add column if not exists document_url text;
alter table problem_statements drop constraint if exists problem_statements_document_url_chk;
alter table problem_statements add constraint problem_statements_document_url_chk check (document_url is null or document_url ~ '^https://');

-- ------------------------------------------- RLS for the server role
-- Browsers never reach the database. All access is through service_role, which on
-- Supabase bypasses RLS and elsewhere gets this explicit full-access policy.
-- anon / authenticated still have no grants and no policies.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('drop policy if exists server_all on public.%I', t);
    execute format('create policy server_all on public.%I for all to service_role using (true) with check (true)', t);
  end loop;
end $$;

-- ---------------------------------------------------------- functions
create or replace function upsert_admin_user(p_email text, p_display_name text, p_role admin_role,
                                             p_can_issue boolean, p_password_hash text)
returns jsonb language plpgsql as $$
declare v_email text := lower(btrim(p_email)); v_id uuid;
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then perform dx_raise('INVALID_INPUT', 'Invalid email'); end if;
  select user_id into v_id from admin_users where lower(email) = v_email;
  if v_id is null then
    insert into admin_users (email, display_name, role, can_issue_credentials, password_hash)
    values (v_email, p_display_name, p_role, coalesce(p_can_issue, false), p_password_hash) returning user_id into v_id;
  else
    update admin_users set display_name = coalesce(p_display_name, display_name), role = p_role,
           can_issue_credentials = coalesce(p_can_issue, can_issue_credentials),
           password_hash = coalesce(p_password_hash, password_hash), is_active = true
     where user_id = v_id;
    update admin_sessions set revoked_at = now() where user_id = v_id and revoked_at is null and p_password_hash is not null;
  end if;
  perform dx_audit(null, 'system', 'cli', 'admin.upserted', 'admin', v_id::text, null,
                   jsonb_build_object('email', v_email, 'role', p_role, 'can_issue', p_can_issue, 'password_set', p_password_hash is not null));
  return jsonb_build_object('user_id', v_id, 'email', v_email, 'role', p_role);
end $$;

create or replace function admin_login_lookup(p_email text) returns jsonb language sql stable as $$
  select jsonb_build_object('user_id', user_id, 'password_hash', password_hash, 'is_active', is_active)
  from admin_users where lower(email) = lower(btrim(p_email));
$$;

create or replace function create_admin_session(p_user uuid, p_token_hash text, p_ttl_minutes int, p_ip text, p_ua text)
returns void language plpgsql as $$
begin
  insert into admin_sessions (user_id, token_hash, expires_at, ip, user_agent)
  values (p_user, p_token_hash, now() + make_interval(mins => p_ttl_minutes), left(p_ip, 64), left(p_ua, 300));
  update admin_users set last_login_at = now() where user_id = p_user;
  perform dx_audit(null, 'admin', p_user::text, 'admin.login', 'admin', p_user::text, null, jsonb_build_object('ip', p_ip));
end $$;

create or replace function resolve_admin_session(p_token_hash text) returns jsonb language sql stable as $$
  select jsonb_build_object('user_id', u.user_id, 'email', u.email, 'display_name', u.display_name, 'role', u.role,
                            'can_issue_credentials', u.can_issue_credentials)
  from admin_sessions s join admin_users u on u.user_id = s.user_id
  where s.token_hash = p_token_hash and s.revoked_at is null and s.expires_at > now() and u.is_active;
$$;

create or replace function revoke_admin_session(p_token_hash text) returns void language sql as $$
  update admin_sessions set revoked_at = now() where token_hash = p_token_hash and revoked_at is null;
$$;

-- Problem documents are links now (no storage bucket needed).
create or replace function team_arena_state(p_team uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'team', jsonb_build_object('id', t.id, 'team_number', t.team_number, 'name', t.name, 'status', t.registration_status),
    'members', coalesce((select jsonb_agg(jsonb_build_object('slot', 'P' || s.slot_number, 'name', s.participant_name) order by s.slot_number)
                         from participant_slots s where s.team_id = t.id and s.occupancy = 'occupied'), '[]'::jsonb),
    'problems_open', e.problems_open,
    'assignment', (select jsonb_build_object('problem_id', a.problem_id, 'code', p.code, 'title', p.title, 'locked_at', a.locked_at)
                   from problem_assignments a join problem_statements p on p.id = a.problem_id where a.team_id = t.id),
    'problems', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'code', p.code, 'title', p.title, 'summary', p.summary,
                            'capacity', p.capacity, 'document_url', p.document_url,
                            'remaining', p.capacity - (select count(*) from problem_assignments a where a.problem_id = p.id))
                          order by p.sort_order, p.code)
                          from problem_statements p where p.event_id = t.event_id and p.is_active), '[]'::jsonb))
  from teams t join events e on e.id = t.event_id where t.id = p_team;
$$;

-- purge also trims expired admin sessions
create or replace function purge_expired_packages() returns int language plpgsql as $$
declare n int;
begin
  update credential_packages set ciphertext = null, iv = null, auth_tag = null, purged_at = now()
   where purged_at is null and expires_at <= now();
  get diagnostics n = row_count;
  delete from auth_attempts where attempted_at < now() - interval '2 days';
  update arena_sessions set revoked_at = now(), revoked_reason = 'expired' where revoked_at is null and expires_at <= now();
  delete from admin_sessions where expires_at < now() - interval '7 days';
  if n > 0 then perform dx_audit(null, 'system', 'cron', 'credentials.packages_expired', null, null, null, jsonb_build_object('purged', n)); end if;
  return n;
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
