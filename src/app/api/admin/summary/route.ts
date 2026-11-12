import { route, json } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/supabase/server';
import { currentEvent } from '@/lib/event';

export const GET = route(async () => {
  await requireAdmin({ role: 'viewer' });
  const ev = await currentEvent(db());
  return json(await db().rpc('admin_event_summary', { p_event: ev.id }));
});
