import { z } from 'zod';
import { route, json, body } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';

export const GET = route(async () => {
  await requireAdmin({ role: 'viewer' });
  const ev = await currentEvent(db());
  return json({ people: await db().rpc('admin_roster_list', { p_event: ev.id }) });
});

const personSchema = z.object({
  employee_id: z.string().trim().min(2).max(40), name: z.string().trim().min(2).max(100),
  email: z.string().trim().max(200).nullish(), department: z.string().trim().max(100).nullish(), original: z.string().max(40).nullish(),
});

/** Add one person, or edit (original = their current employee ID). */
export const POST = route(async (req) => {
  const admin = await requireAdmin({ role: 'admin' });
  const p = await body(req, personSchema);
  const ev = await currentEvent(db());
  await db().rpc('admin_roster_save', {
    p_event: ev.id, p_employee_id: p.employee_id, p_name: p.name, p_email: p.email ?? null, p_department: p.department ?? null,
    p_original: p.original ?? null, p_actor: admin.user_id,
  });
  return json({ ok: true });
});

/** Remove everyone from the list (choices already made are kept). */
export const DELETE = route(async () => {
  const admin = await requireAdmin({ role: 'admin' });
  const ev = await currentEvent(db());
  return json({ removed: await db().rpc('admin_roster_clear', { p_event: ev.id, p_actor: admin.user_id }) });
});
