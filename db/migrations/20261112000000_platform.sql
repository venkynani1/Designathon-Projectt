-- =====================================================================
-- DESIGNATHON X — Migration 0: platform prerequisites
-- Creates the roles and the tiny `auth` schema the rest of the schema expects,
-- so it runs on any PostgreSQL 15+ host (Neon, RDS, local). Every statement is
-- idempotent and a no-op where the objects already exist (e.g. on Supabase).
-- =====================================================================
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  -- The server-side role every application query runs as. On non-Supabase hosts it
  -- cannot have BYPASSRLS, so migration 4 grants it explicit row-level policies.
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $roles$;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text);

do $uid$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'auth' and p.proname = 'uid') then
    execute $fn$
      create function auth.uid() returns uuid language sql stable
      as 'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid'
    $fn$;
  end if;
end $uid$;
