import { z } from 'zod';
import { route, json, body } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';

export const GET = route(async () => {
  await requireAdmin({ role: 'viewer' });
  const ev = await currentEvent(db());
  return json({ autopicks: await db().rpc('admin_autopick_list', { p_event: ev.id }) });
});

const schema = z.object({
  employee_id: z.string().trim().min(2).max(40),
  name: z.string().trim().max(100).default(''),
  prefs: z.array(z.string().uuid()).min(1).max(10),
});

export const POST = route(async (req) => {
  const admin = await requireAdmin({ role: 'admin' });
  const a = await body(req, schema);
  const ev = await currentEvent(db());
  return json(await db().rpc('admin_autopick_save', { p_event: ev.id, p_employee_id: a.employee_id, p_name: a.name, p_prefs: a.prefs, p_actor: admin.user_id }));
});
