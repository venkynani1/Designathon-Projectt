import { createHash, randomBytes } from 'node:crypto';
import { route, json, body, clientIp } from '@/lib/http';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { surveySubmitSchema } from '@/lib/validation';
import { enforceRateLimit, recordAttempt, surveyRules } from '@/lib/rateLimit';
import { DxError } from '@/lib/errors';

export const runtime = 'nodejs';

const DEVICE_COOKIE = 'dx_dev';

/** One goodie per employee ID and one response per phone. Stock is checked atomically in the database. */
export const POST = route(async (req) => {
  const input = await body(req, surveySubmitSchema);
  const ev = await currentEvent(db());
  const rules = surveyRules(ev.id, input.employee_id, clientIp(req));
  await enforceRateLimit(db(), rules);
  // listed people are assigned first, committed on its own
  await db().rpc('autopick_run_pending', { p_event: ev.id });
  const existing = req.cookies.get(DEVICE_COOKIE)?.value;
  const device = existing && /^[A-Za-z0-9_-]{20,64}$/.test(existing) ? existing : randomBytes(24).toString('base64url');
  const deviceHash = createHash('sha256').update(`dev:${ev.id}:${device}`).digest('hex');
  try {
    const res = await db().rpc('survey_submit', {
      p_event: ev.id, p_employee_id: input.employee_id, p_name: input.name,
      p_goodie: input.attending ? input.goodie_id : null, p_meal: input.attending ? input.meal : null,
      p_attending: input.attending, p_device: deviceHash,
    });
    await recordAttempt(db(), rules, true);
    const out = json(res);
    out.cookies.set(DEVICE_COOKIE, device, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 60 });
    return out;
  } catch (e) {
    if (e instanceof DxError && e.code !== 'OUT_OF_STOCK') await recordAttempt(db(), rules, false);
    throw e;
  }
});
