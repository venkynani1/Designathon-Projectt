import { route, json, body } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { photoSchema, uuid } from '@/lib/validation';

type Ctx = { params: Promise<{ id: string }> };

/** Upload a photo (already resized in the browser) for a goodie. */
export const POST = route<Ctx>(async (req, { params }) => {
  const admin = await requireAdmin({ role: 'admin' });
  const id = uuid.parse((await params).id);
  const p = await body(req, photoSchema);
  const ev = await currentEvent(db());
  return json(await db().rpc('admin_set_goodie_image', { p_event: ev.id, p_id: id, p_mime: p.mime, p_data_b64: p.data, p_actor: admin.user_id }));
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const admin = await requireAdmin({ role: 'admin' });
  const id = uuid.parse((await params).id);
  const ev = await currentEvent(db());
  await db().rpc('admin_remove_goodie_image', { p_event: ev.id, p_id: id, p_actor: admin.user_id });
  return json({ ok: true });
});
