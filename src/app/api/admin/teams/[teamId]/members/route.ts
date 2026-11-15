import { route, json, body } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { authorizePrivileged } from '@/lib/auth/roles';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { addMemberSchema, uuid } from '@/lib/validation';

type Ctx = { params: Promise<{ teamId: string }> };

/** Adds a participant to the first vacant slot (P1→P4). The slot keeps its permanent PIN. */
export const POST = route<Ctx>(async (req, { params }) => {
  const admin = await requireAdmin({ role: 'registrar' });
  const teamId = uuid.parse((await params).teamId);
  const input = await body(req, addMemberSchema);
  const privileged = authorizePrivileged(admin, input.privileged);
  const ev = await currentEvent(db());
  return json(await db().rpc('add_member', {
    p_event: ev.id, p_team: teamId, p_member: input.member, p_actor: admin.user_id, p_privileged: privileged, p_reason: input.reason ?? null,
  }));
});
