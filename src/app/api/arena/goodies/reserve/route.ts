import { route, json, body } from '@/lib/http';
import { db } from '@/lib/server/db';
import { requireArenaSession } from '@/lib/arenaSession';
import { reserveSchema } from '@/lib/validation';

/** One permanent reservation per employee, stock-safe (enforced in PostgreSQL). */
export const POST = route(async (req) => {
  const s = await requireArenaSession(db(), 'participant');
  const { goodie_id } = await body(req, reserveSchema);
  return json(await db().rpc('reserve_goodie', { p_identity: s.identity_id, p_goodie: goodie_id, p_session: s.session_id }));
});
