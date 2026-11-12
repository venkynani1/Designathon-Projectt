import { route, json } from '@/lib/http';
import { db } from '@/lib/supabase/server';
import { requireArenaSession } from '@/lib/arenaSession';

export const GET = route(async () => {
  const s = await requireArenaSession(db(), 'participant');
  return json(await db().rpc('participant_arena_state', { p_identity: s.identity_id }));
});
