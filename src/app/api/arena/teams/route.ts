import { route, json } from '@/lib/http';
import { db } from '@/lib/supabase/server';
import { currentEvent } from '@/lib/event';

/** Public team directory for the login picker: registered teams' number + name only. */
export const GET = route(async (req) => {
  const q = (req.nextUrl.searchParams.get('q') ?? '').slice(0, 60);
  const ev = await currentEvent(db());
  return json({ teams: await db().rpc('arena_team_directory', { p_event: ev.id, p_q: q }) });
});
