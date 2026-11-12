import { route, json } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/supabase/server';
import { currentEvent } from '@/lib/event';

export const GET = route(async (req) => {
  await requireAdmin({ role: 'admin' });
  const ev = await currentEvent(db());
  const entity = req.nextUrl.searchParams.get('entity');
  return json({ entries: await db().rpc('admin_audit', { p_event: ev.id, p_entity: entity && /^[0-9a-f-]{36}$/i.test(entity) ? entity : null, p_limit: 300 }) });
});
