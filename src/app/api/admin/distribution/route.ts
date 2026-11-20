import { route, json } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';

export const GET = route(async () => {
  const admin = await requireAdmin({ role: 'viewer' });
  const ev = await currentEvent(db());
  const [summary, desk] = await Promise.all([
    db().rpc('admin_distribution_summary', { p_event: ev.id }),
    admin.role === 'viewer' ? null : db().rpc('admin_desk_get', { p_event: ev.id }),
  ]);
  return json({ summary, desk });
});
