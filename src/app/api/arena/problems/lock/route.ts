import { route, json, body } from '@/lib/http';
import { db } from '@/lib/supabase/server';
import { requireArenaSession } from '@/lib/arenaSession';
import { lockSchema } from '@/lib/validation';

/** Atomic, capacity-safe lock; one assignment per team (enforced in PostgreSQL). */
export const POST = route(async (req) => {
  const s = await requireArenaSession(db(), 'team');
  const { problem_id } = await body(req, lockSchema);
  await db().rpc('lock_problem', { p_team: s.team_id, p_problem: problem_id, p_session: s.session_id });
  return json({ ok: true });
});
