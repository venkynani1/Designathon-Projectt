#!/usr/bin/env node
/**
 * Database setup — runs automatically before every Vercel build (see vercel.json) and
 * can be run by hand:  DATABASE_URL=postgres://... node scripts/migrate.mjs
 *
 *  1. Applies db/migrations/*.sql in order, each exactly once (tracked in dx_schema_migrations),
 *     under an advisory lock so concurrent builds can't race.
 *  2. Ensures the least-privilege login role `dx_app` (member of service_role) that the app
 *     uses at runtime. Its password is derived from DX_PIN_PEPPER, so no extra secret exists.
 *  3. Seeds db/seed.sql only if the event does not exist yet.
 *  4. Bootstraps the first organizer from DX_BOOTSTRAP_ADMIN_EMAIL / DX_BOOTSTRAP_ADMIN_PASSWORD
 *     if that account does not have a password yet (never overwrites an existing password).
 *
 * Connects with the DIRECT (non-pooled) owner connection: DATABASE_URL_UNPOOLED, else DATABASE_URL.
 */
import pg from 'pg';
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || process.env.DX_DATABASE_URL;
if (!url) {
  console.log('[migrate] no DATABASE_URL — skipping database setup');
  process.exit(0);
}
const root = process.cwd();
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
await client.connect();
await client.query(`select pg_advisory_lock(hashtext('dx-migrate'))`);
try {
  await client.query('create table if not exists public.dx_schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await client.query('select name from dx_schema_migrations')).rows.map((r) => r.name));
  const dir = path.join(root, 'db/migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await client.query('begin');
    try {
      await client.query(readFileSync(path.join(dir, f), 'utf8'));
      await client.query('insert into dx_schema_migrations (name) values ($1)', [f]);
      await client.query('commit');
      console.log(`[migrate] applied ${f}`);
    } catch (e) {
      await client.query('rollback');
      throw new Error(`migration ${f} failed: ${e.message}`);
    }
  }
  await client.query('revoke all on public.dx_schema_migrations from public');

  // ---- least-privilege runtime role
  const pepper = process.env.DX_PIN_PEPPER;
  if (pepper) {
    const pw = createHmac('sha256', Buffer.from(pepper, 'base64')).update('dx-app-db-password:v1').digest('base64url');
    const exists = (await client.query(`select 1 from pg_roles where rolname = 'dx_app'`)).rowCount > 0;
    await client.query(`${exists ? 'alter' : 'create'} role dx_app with login password '${pw}'`);
    await client.query('grant service_role to dx_app');
    await client.query(`alter role dx_app set role = 'service_role'`);
    const db = (await client.query('select current_database() as d')).rows[0].d;
    await client.query(`grant connect on database "${db.replace(/"/g, '')}" to dx_app`);
    console.log('[migrate] runtime role dx_app ready');
  }

  // ---- seed (first run only)
  const code = process.env.DX_EVENT_CODE ?? 'designathon-x';
  const hasEvent = (await client.query('select 1 from events where code = $1', [code])).rowCount > 0;
  if (!hasEvent) {
    await client.query(readFileSync(path.join(root, 'db/seed.sql'), 'utf8'));
    console.log('[migrate] seeded db/seed.sql');
  }

  // ---- first organizer (never overwrites an existing password)
  const email = process.env.DX_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.DX_BOOTSTRAP_ADMIN_PASSWORD;
  if (email && password) {
    const row = (await client.query('select password_hash from admin_users where lower(email) = $1', [email])).rows[0];
    if (!row?.password_hash) {
      if (password.length < 12) throw new Error('DX_BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters');
      const { hash } = await import('@node-rs/argon2');
      const h = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 });
      await client.query(
        `select upsert_admin_user(p_email => $1, p_display_name => 'Event Owner', p_role => 'superadmin', p_can_issue => true, p_password_hash => $2)`,
        [email, h],
      );
      console.log(`[migrate] created organizer ${email} (superadmin, credential issuer)`);
    }
  }
} finally {
  await client.query(`select pg_advisory_unlock(hashtext('dx-migrate'))`).catch(() => {});
  await client.end();
}
