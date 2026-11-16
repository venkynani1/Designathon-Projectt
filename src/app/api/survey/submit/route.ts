import { route, json, body, clientIp } from '@/lib/http';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { surveySubmitSchema } from '@/lib/validation';
import { enforceRateLimit, recordAttempt, surveyRules } from '@/lib/rateLimit';
import { DxError } from '@/lib/errors';

/** One goodie per employee ID. Stock is checked and decremented atomically in the database. */
export const POST = route(async (req) => {
  const input = await body(req, surveySubmitSchema);
  const ev = await currentEvent(db());
  const rules = surveyRules(ev.id, input.employee_id, clientIp(req));
  await enforceRateLimit(db(), rules);
  try {
    const res = await db().rpc('survey_submit', { p_event: ev.id, p_employee_id: input.employee_id, p_name: input.name, p_goodie: input.goodie_id });
    await recordAttempt(db(), rules, true);
    return json(res);
  } catch (e) {
    if (e instanceof DxError && e.code !== 'OUT_OF_STOCK') await recordAttempt(db(), rules, false);
    throw e;
  }
});
