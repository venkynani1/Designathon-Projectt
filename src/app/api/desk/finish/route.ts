import { route, json } from '@/lib/http';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { requireDesk, setDeskCookie } from '@/lib/auth/desk';

/** This distributor is done (other desks carry on). They can then download the attendance file. */
export const POST = route(async () => {
  const ev = await currentEvent(db());
  const d = await requireDesk(db(), ev.id, { allowFinished: true });
  await db().rpc('dx_audit', { p_event: ev.id, p_actor_type: 'system', p_actor_id: `desk:${d.name}`, p_action: 'desk.finished',
    p_entity_type: 'desk', p_entity_id: d.name, p_reason: null, p_details: null });
  const res = json({ ok: true });
  setDeskCookie(res, ev.id, d.version, d.name, true);
  return res;
});
