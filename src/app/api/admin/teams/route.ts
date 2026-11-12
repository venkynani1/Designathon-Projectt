import { route, json } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/supabase/server';
import { currentEvent } from '@/lib/event';

export const GET = route(async (req) => {
  await requireAdmin({ role: 'viewer' });
  const ev = await currentEvent(db());
  const q = (req.nextUrl.searchParams.get('q') ?? '').slice(0, 100);
  return json({ teams: await db().rpc('admin_list_teams', { p_event: ev.id, p_q: q }) });
});
