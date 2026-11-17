import { z } from 'zod';
import { route, json, body, clientIp } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { pickerPasswordOk, setPickerCookie, pickerUnlocked } from '@/lib/auth/picker';
import { db } from '@/lib/server/db';
import { enforceRateLimit, recordAttempt } from '@/lib/rateLimit';
import { DxError } from '@/lib/errors';

export const runtime = 'nodejs';

export const GET = route(async () => {
  const admin = await requireAdmin({ role: 'admin' });
  return json({ unlocked: await pickerUnlocked(admin.user_id) });
});

export const POST = route(async (req) => {
  const admin = await requireAdmin({ role: 'admin' });
  const { password } = await body(req, z.object({ password: z.string().max(200) }));
  const rules = [{ key: `picker:${admin.user_id}`, max: 5, windowSeconds: 15 * 60 }, { key: `ip:${clientIp(req)}:picker`, max: 20, windowSeconds: 15 * 60 }];
  await enforceRateLimit(db(), rules);
  const ok = pickerPasswordOk(password);
  await recordAttempt(db(), rules, ok);
  if (!ok) throw new DxError('INVALID_CREDENTIALS', 'Wrong password');
  const res = json({ ok: true });
  setPickerCookie(res, admin.user_id);
  return res;
});
