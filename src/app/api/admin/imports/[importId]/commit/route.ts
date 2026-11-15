import { route, json, body } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { authorizePrivileged } from '@/lib/auth/roles';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { commitSchema, uuid } from '@/lib/validation';

type Ctx = { params: Promise<{ importId: string }> };

/** Step 3: commit the stored (server-side) plan in ONE transaction; the database re-validates everything. */
export const POST = route<Ctx>(async (req, { params }) => {
  const admin = await requireAdmin({ role: 'registrar' });
  const importId = uuid.parse((await params).importId);
  const input = await body(req, commitSchema);
  const ev = await currentEvent(db());
  return json(await db().rpc('commit_import', {
    p_event: ev.id, p_import: importId, p_actor: admin.user_id, p_privileged: authorizePrivileged(admin, input.privileged), p_reason: input.reason ?? null,
  }));
});
