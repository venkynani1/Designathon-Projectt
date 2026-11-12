import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { env } from '../env';
import pg from 'pg';
import { dbFromSupabase, type Db } from '../db';
import { pgDb } from '../pgDb';

let service: SupabaseClient | null = null;

/** Service-role client. Server-only: never import from a client component. */
export function serviceClient(): SupabaseClient {
  service ??= createClient(env.supabaseUrl(), env.serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'designathon-x' } },
  });
  return service;
}

let direct: Db | null = null;

/**
 * Data access. Default: Supabase RPC with the service role.
 * Optional: DX_DATABASE_URL (e.g. Supabase transaction pooler, port 6543) for direct
 * PostgreSQL — connect as a role with the same grants as service_role.
 */
export function db(): Db {
  const url = process.env.DX_DATABASE_URL;
  if (url) {
    if (!direct) {
      const pool = new pg.Pool({ connectionString: url, max: 5 });
      if (process.env.DX_DATABASE_ROLE) pool.on('connect', (c) => void c.query(`set role ${process.env.DX_DATABASE_ROLE!.replace(/[^a-z_]/g, '')}`));
      direct = pgDb(pool);
    }
    return direct;
  }
  return dbFromSupabase(serviceClient());
}

/** Cookie-bound client used only to identify the signed-in administrator. */
export async function authClient() {
  const store = await cookies();
  return createServerClient(env.supabaseUrl(), env.supabaseAnonKey(), {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          /* called from a Server Component — middleware refreshes the session */
        }
      },
    },
  });
}
