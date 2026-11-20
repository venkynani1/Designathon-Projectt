import { route, json } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';

/** New desk PIN — signs out every distributor. */
export const POST = route(async () => {
  const admin = await requireAdmin({ role: 'admin' });
  const ev = await currentEvent(db());
  return json(await db().rpc('admin_desk_new_pin', { p_event: ev.id, p_actor: admin.user_id }));
});
