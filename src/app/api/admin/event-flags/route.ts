import { route, json, body } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/supabase/server';
import { currentEvent } from '@/lib/event';
import { flagsSchema } from '@/lib/validation';

/** Open/close arenas and freeze participant edits. Opening Goodies freezes edits automatically. */
export const POST = route(async (req) => {
  const admin = await requireAdmin({ role: 'admin' });
  const flags = await body(req, flagsSchema);
  const ev = await currentEvent(db());
  const res = await db().rpc('set_event_flags', { p_event: ev.id, p_flags: flags, p_actor: admin.user_id });
  await currentEvent(db(), true);
  return json(res);
});
