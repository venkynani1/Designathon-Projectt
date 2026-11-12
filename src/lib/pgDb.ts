import pg from 'pg';
import type { Db } from './db';
import { fromDbError } from './errors';

/**
 * Direct PostgreSQL implementation of Db (same functions, same transactions).
 * Used by the integration tests and optionally in production via DX_DATABASE_URL
 * (e.g. the Supabase transaction pooler) instead of PostgREST.
 */
export function pgDb(pool: pg.Pool): Db {
  const sigCache = new Map<string, Map<string, string>>();
  async function signature(fn: string) {
    let s = sigCache.get(fn);
    if (!s) {
      if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw new Error('invalid function name');
      const r = await pool.query(
        `select unnest(proargnames) as n, unnest(proargtypes::oid[]::regtype[]::text[]) as t
           from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`, [fn]);
      s = new Map(r.rows.map((x) => [x.n as string, x.t as string]));
      sigCache.set(fn, s);
    }
    return s;
  }
  return {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
      const sig = await signature(fn);
      const keys = Object.keys(args);
      for (const k of keys) if (!sig.has(k)) throw new Error(`Unknown argument ${k} for ${fn}`);
      const params = keys.map((k) => {
        const v = args[k];
        return sig.get(k) === 'jsonb' && v !== null && v !== undefined ? JSON.stringify(v) : v ?? null;
      });
      const call = `select ${fn}(${keys.map((k, i) => `${k} => $${i + 1}::${sig.get(k)}`).join(', ')}) as r`;
      try {
        const res = await pool.query(call, params);
        return res.rows[0]?.r as T;
      } catch (e) {
        throw fromDbError(e);
      }
    },
  };
}
