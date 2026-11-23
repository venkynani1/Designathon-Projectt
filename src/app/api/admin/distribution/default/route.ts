import { z } from 'zod';
import { route, json, body } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';

/** Default goodie for people who never responded (given when they scan at the desk). */
export const POST = route(async (req) => {
  const admin = await requireAdmin({ role: 'admin' });
  const { goodie_id } = await body(req, z.object({ goodie_id: z.string().uuid().nullable() }));
  const ev = await currentEvent(db());
  return json(await db().rpc('admin_set_default_goodie', { p_event: ev.id, p_goodie: goodie_id, p_actor: admin.user_id }));
});
