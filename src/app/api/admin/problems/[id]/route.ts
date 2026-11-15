import { route, json } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { uuid } from '@/lib/validation';

type Ctx = { params: Promise<{ id: string }> };

/** Only possible while no team has locked it; otherwise hide it. */
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const admin = await requireAdmin({ role: 'admin' });
  const id = uuid.parse((await params).id);
  const ev = await currentEvent(db());
  await db().rpc('admin_delete_problem', { p_event: ev.id, p_id: id, p_actor: admin.user_id });
  return json({ ok: true });
});
