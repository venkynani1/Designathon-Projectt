import { route, json } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { uuid } from '@/lib/validation';

type Ctx = { params: Promise<{ packageId: string }> };

/** Destroys a package's encrypted PINs immediately (e.g. once all slips are handed out). Irreversible. */
export const POST = route<Ctx>(async (_req, { params }) => {
  const admin = await requireAdmin({ role: 'admin', issueCredentials: true });
  const id = uuid.parse((await params).packageId);
  const ev = await currentEvent(db());
  await db().rpc('purge_package', { p_event: ev.id, p_package: id, p_actor: admin.user_id });
  return json({ ok: true });
});
