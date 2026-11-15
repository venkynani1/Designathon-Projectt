import pg from 'pg';
import { createHmac } from 'node:crypto';
import type { Db } from '../db';
import { pgDb } from '../pgDb';
import { DxError } from '../errors';

let cached: Db | null = null;

/**
 * The app never connects as the database owner. scripts/migrate.mjs creates the login role
 * `dx_app` (member of service_role) with a password derived from DX_PIN_PEPPER; here we
 * swap those credentials into the provider's POOLED connection string.
 */
function runtimeUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DX_DATABASE_URL;
  if (!url) throw new DxError('CONFIG', 'DATABASE_URL is not set');
  if (process.env.DX_DATABASE_ROLE || process.env.DX_APP_DB_ROLE === 'off' || !process.env.DX_PIN_PEPPER) return url;
  const u = new URL(url);
  u.username = 'dx_app';
  u.password = createHmac('sha256', Buffer.from(process.env.DX_PIN_PEPPER, 'base64')).update('dx-app-db-password:v1').digest('base64url');
  return u.toString();
}

export function db(): Db {
  if (cached) return cached;
  const pool = new pg.Pool({
    connectionString: runtimeUrl(),
    max: Number(process.env.DX_DATABASE_POOL) || 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (e) => console.error('[dx] pg pool error', e.message));
  const role = process.env.DX_DATABASE_ROLE; // local/dev only
  if (role) pool.on('connect', (c) => void c.query(`set role ${role.replace(/[^a-z_]/g, '')}`));
  cached = pgDb(pool);
  return cached;
}
