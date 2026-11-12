import { fromDbError } from './errors';

/**
 * The database is the API boundary: every read/write is a PostgreSQL function
 * executed in its own transaction. The same interface is backed by Supabase
 * (PostgREST RPC with the service role) in production and by node-postgres in tests.
 */
export interface Db {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T>;
}

type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};

export function dbFromSupabase(client: RpcClient): Db {
  return {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
      const { data, error } = await client.rpc(fn, args);
      if (error) throw fromDbError(error);
      return data as T;
    },
  };
}
