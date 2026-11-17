import { route, json } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';

type Ctx = { params: Promise<{ employeeId: string }> };

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const admin = await requireAdmin({ role: 'admin' });
  const emp = decodeURIComponent((await params).employeeId).slice(0, 40);
  const ev = await currentEvent(db());
  await db().rpc('admin_roster_delete', { p_event: ev.id, p_employee_id: emp, p_actor: admin.user_id });
  return json({ ok: true });
});
