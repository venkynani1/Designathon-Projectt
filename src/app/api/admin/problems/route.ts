import { route, json, body } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { problemSchema } from '@/lib/validation';

export const GET = route(async () => {
  await requireAdmin({ role: 'viewer' });
  const ev = await currentEvent(db());
  return json({ problems: await db().rpc('admin_list_problems', { p_event: ev.id }) });
});

/** Create (no id) or update (with id). Team limit can't go below teams that already locked it. */
export const POST = route(async (req) => {
  const admin = await requireAdmin({ role: 'admin' });
  const p = await body(req, problemSchema);
  const ev = await currentEvent(db());
  return json(await db().rpc('admin_upsert_problem', {
    p_event: ev.id, p_id: p.id ?? null, p_code: p.code, p_title: p.title, p_summary: p.summary ?? null, p_capacity: p.capacity,
    p_document_url: p.document_url, p_is_active: p.is_active, p_sort_order: p.sort_order ?? null, p_actor: admin.user_id,
  }));
});
