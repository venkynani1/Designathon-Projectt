import { route, json, body } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { renameSchema, uuid } from '@/lib/validation';
import { DxError } from '@/lib/errors';

type Ctx = { params: Promise<{ teamId: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  await requireAdmin({ role: 'viewer' });
  const teamId = uuid.parse((await params).teamId);
  const ev = await currentEvent(db());
  const [detail, credentials] = await Promise.all([
    db().rpc('admin_team_detail', { p_event: ev.id, p_team: teamId }),
    db().rpc('current_credentials_for_team', { p_event: ev.id, p_team: teamId }),
  ]);
  if (!detail) throw new DxError('NOT_FOUND', 'Team not found');
  return json({ ...(detail as object), credentials });
});

/** Rename — never touches credentials, assignments or reservations. */
export const PATCH = route<Ctx>(async (req, { params }) => {
  const admin = await requireAdmin({ role: 'registrar' });
  const teamId = uuid.parse((await params).teamId);
  const { name } = await body(req, renameSchema);
  const ev = await currentEvent(db());
  return json(await db().rpc('rename_team', { p_event: ev.id, p_team: teamId, p_name: name, p_actor: admin.user_id }));
});
