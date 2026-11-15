#!/usr/bin/env node
/**
 * Create or update an organizer account (and reset its password).
 *
 *   DATABASE_URL=postgres://... node scripts/create-admin.mjs you@company.com superadmin "Your Name" --issuer
 *
 * Roles: viewer | registrar | admin | superadmin.  --issuer = may print/reissue PIN slips.
 * The password is read from ADMIN_PASSWORD, or a strong one is generated and printed ONCE.
 */
import pg from 'pg';
import { hash } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';

const [email, role = 'admin', name = null, ...flags] = process.argv.slice(2);
const roles = ['viewer', 'registrar', 'admin', 'superadmin'];
if (!email || !roles.includes(role)) {
  console.error('Usage: node scripts/create-admin.mjs <email> <viewer|registrar|admin|superadmin> ["Display Name"] [--issuer]');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) { console.error('Set DATABASE_URL'); process.exit(1); }
const generated = !process.env.ADMIN_PASSWORD;
const password = process.env.ADMIN_PASSWORD ?? randomBytes(12).toString('base64url');
if (password.length < 12) { console.error('ADMIN_PASSWORD must be at least 12 characters'); process.exit(1); }
const passwordHash = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 });
const client = new pg.Client({ connectionString: url });
await client.connect();
if (process.env.DX_DATABASE_ROLE) await client.query(`set role ${process.env.DX_DATABASE_ROLE.replace(/[^a-z_]/g, '')}`);
const { rows } = await client.query(
  'select upsert_admin_user(p_email => $1, p_display_name => $2, p_role => $3::admin_role, p_can_issue => $4, p_password_hash => $5) as r',
  [email, name, role, flags.includes('--issuer'), passwordHash],
);
await client.end();
console.log(`Saved ${rows[0].r.email} as ${role}${flags.includes('--issuer') ? ' (credential issuer)' : ''}.`);
if (generated) console.log(`Password (shown once): ${password}`);
