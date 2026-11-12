import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { Db } from '@/lib/db';
import { pgDb } from '@/lib/pgDb';

/**
 * Real PostgreSQL integration harness. Each test file gets a fresh database with the
 * production migrations applied (plus a tiny stand-in for Supabase's auth schema/roles).
 * Connection: DX_TEST_PG (default postgres://postgres@127.0.0.1:54329/postgres).
 */
const ADMIN_URL = process.env.DX_TEST_PG ?? 'postgres://postgres@127.0.0.1:54329/postgres';
const ROOT = path.resolve(__dirname, '../..');

export interface TestDb {
  db: Db;
  pool: pg.Pool;
  eventId: string;
  actorId: string;
  name: string;
  sql: (q: string, params?: unknown[]) => Promise<pg.QueryResult>;
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const name = `dx_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);

  const setup = new pg.Client({ connectionString: url });
  await setup.connect();
  await setup.query(readFileSync(path.join(ROOT, 'tests/db/supabase-stub.sql'), 'utf8'));
  const migDir = path.join(ROOT, 'supabase/migrations');
  for (const f of readdirSync(migDir).filter((x) => x.endsWith('.sql') && !x.includes('storage')).sort()) {
    await setup.query(readFileSync(path.join(migDir, f), 'utf8'));
  }
  const actor = await setup.query(`insert into auth.users (email) values ('admin@corp.example') returning id`);
  const actorId = actor.rows[0].id as string;
  await setup.query(`insert into admin_users (user_id, email, role, can_issue_credentials) values ($1, 'admin@corp.example', 'superadmin', true)`, [actorId]);
  const ev = await setup.query(`insert into events (code, name) values ('test-event', 'Designathon X Test') returning id`);
  await setup.end();

  // All application calls run as service_role — exactly like the Supabase server client.
  const pool = new pg.Pool({ connectionString: url, max: 30 });
  pool.on('connect', (c) => void c.query('set role service_role'));

  const db = pgDb(pool);
  return {
    db, pool, eventId: ev.rows[0].id, actorId, name,
    sql: (q, p) => pool.query(q, p as unknown[]),
    close: async () => {
      await pool.end();
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}

export const secrets = { pepper: randomBytes(32), vaultKey: randomBytes(32) };
