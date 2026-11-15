import { route, json, body } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { goodieSchema } from '@/lib/validation';

export const GET = route(async () => {
  await requireAdmin({ role: 'viewer' });
  const ev = await currentEvent(db());
  return json({ goodies: await db().rpc('admin_list_goodies', { p_event: ev.id }) });
});

/** Create (no id) or update (with id). Quantity can't go below what's already reserved. */
export const POST = route(async (req) => {
  const admin = await requireAdmin({ role: 'admin' });
  const g = await body(req, goodieSchema);
  const ev = await currentEvent(db());
  return json(await db().rpc('admin_upsert_goodie', {
    p_event: ev.id, p_id: g.id ?? null, p_name: g.name, p_description: g.description ?? null, p_stock: g.stock,
    p_image_url: g.image_url, p_is_active: g.is_active, p_sort_order: g.sort_order ?? null, p_actor: admin.user_id,
  }));
});
