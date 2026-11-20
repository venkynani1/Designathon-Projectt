import { z } from 'zod';
import { route, json, body } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';

/** Set the desk PIN ({pin}) or generate a random one ({}). Signs out every distributor. */
export const POST = route(async (req) => {
  const admin = await requireAdmin({ role: 'admin' });
  const { pin } = await body(req, z.object({ pin: z.string().trim().regex(/^\d{4,8}$/, 'PIN must be 4–8 digits').optional() }));
  const ev = await currentEvent(db());
  return json(pin
    ? await db().rpc('admin_desk_set_pin', { p_event: ev.id, p_pin: pin, p_actor: admin.user_id })
    : await db().rpc('admin_desk_new_pin', { p_event: ev.id, p_actor: admin.user_id }));
});
