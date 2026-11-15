import type { Db } from './db';
import { DxError } from './errors';
import { env } from './env';

export interface EventRow {
  id: string; code: string; name: string; tagline: string | null; venue: string | null; brand_color: string;
  problems_qr_url: string | null; goodies_qr_url: string | null; problems_open: boolean; goodies_open: boolean;
  member_edits_frozen: boolean; package_ttl_hours: number;
}

let cache: { at: number; ev: EventRow } | null = null;

/** The active event (DX_EVENT_CODE). Flags are always re-read inside DB functions, so a short cache is safe. */
export async function currentEvent(db: Db, fresh = false): Promise<EventRow> {
  if (!fresh && cache && Date.now() - cache.at < 15_000) return cache.ev;
  const ev = await db.rpc<EventRow | null>('get_event', { p_code: env.eventCode() });
  if (!ev) throw new DxError('CONFIG', `Event "${env.eventCode()}" not found — run db/seed.sql`);
  cache = { at: Date.now(), ev };
  return ev;
}
