import { z } from 'zod';
import { route, json, body, clientIp } from '@/lib/http';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { currentDesk, setDeskCookie } from '@/lib/auth/desk';
import { enforceRateLimit, recordAttempt } from '@/lib/rateLimit';
import { DxError } from '@/lib/errors';

export const runtime = 'nodejs';

export const GET = route(async () => {
  const ev = await currentEvent(db());
  const d = await currentDesk(db(), ev.id);
  return json({ signed_in: !!d, name: d?.name ?? null, finished: !!d?.finished, event: ev.name });
});

/** Distributor signs in with their name + the shared desk PIN. */
export const POST = route(async (req) => {
  const { name, pin } = await body(req, z.object({ name: z.string().trim().min(2, 'Enter your name').max(40), pin: z.string().trim().max(12) }));
  const ev = await currentEvent(db());
  const rules = [{ key: `desk:${ev.id}:${clientIp(req)}`, max: 10, windowSeconds: 15 * 60 }];
  await enforceRateLimit(db(), rules);
  const version = await db().rpc<number | null>('desk_check_pin', { p_event: ev.id, p_pin: pin });
  await recordAttempt(db(), rules, version != null);
  if (version == null) throw new DxError('INVALID_CREDENTIALS', 'Wrong desk PIN');
  const res = json({ ok: true });
  setDeskCookie(res, ev.id, version, name);
  return res;
});
