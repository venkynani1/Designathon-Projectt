import { z } from 'zod';
import { route, json, body, clientIp } from '@/lib/http';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { enforceRateLimit, recordAttempt, LIMITS } from '@/lib/rateLimit';

/** Participant at the desk: scanned the QR and entered their employee ID -> joins the shared queue. */
export const POST = route(async (req) => {
  const { employee_id } = await body(req, z.object({ employee_id: z.string().trim().min(2).max(40) }));
  const ev = await currentEvent(db());
  const rules = [{ key: `ip:${clientIp(req)}:collect`, ...LIMITS.perIp }];
  await enforceRateLimit(db(), rules);
  await recordAttempt(db(), rules, true);
  return json(await db().rpc('collect_checkin', { p_event: ev.id, p_employee_id: employee_id }));
});
