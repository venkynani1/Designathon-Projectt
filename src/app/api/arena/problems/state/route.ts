import { route, json } from '@/lib/http';
import { db } from '@/lib/server/db';
import { requireArenaSession } from '@/lib/arenaSession';

/** Team-level state, shared by every teammate signed in with the same team PIN. */
export const GET = route(async () => {
  const s = await requireArenaSession(db(), 'team');
  return json(await db().rpc('team_arena_state', { p_team: s.team_id }));
});
