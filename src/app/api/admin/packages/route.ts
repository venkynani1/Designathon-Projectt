import { route, json } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/supabase/server';
import { currentEvent } from '@/lib/event';

export const GET = route(async () => {
  await requireAdmin({ role: 'admin' });
  const ev = await currentEvent(db());
  return json({ packages: await db().rpc('list_packages', { p_event: ev.id }) });
});
