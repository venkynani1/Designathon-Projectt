import { z } from 'zod';
import { route, json, body, clientIp } from '@/lib/http';
import { db } from '@/lib/server/db';
import { DxError } from '@/lib/errors';
import { verifyPassword } from '@/lib/crypto/passwords';
import { hashToken, newSessionToken } from '@/lib/crypto/tokens';
import { enforceRateLimit, recordAttempt, LIMITS } from '@/lib/rateLimit';
import { ADMIN_SESSION_MINUTES, setAdminCookie } from '@/lib/auth/admin';

export const runtime = 'nodejs';

const schema = z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().max(200) });

/** Organizer sign-in: email + password (Argon2id), rate-limited, revocable server session. */
export const POST = route(async (req) => {
  const { email, password } = await body(req, schema);
  const ip = clientIp(req);
  const rules = [
    { key: `admin:${email}`, ...LIMITS.perTarget },
    { key: `ip:${ip}:admin`, max: 50, windowSeconds: 15 * 60 },
  ];
  await enforceRateLimit(db(), rules);
  const rec = await db().rpc<{ user_id: string; password_hash: string | null; is_active: boolean } | null>('admin_login_lookup', { p_email: email });
  const ok = await verifyPassword(rec?.password_hash ?? null, password);
  if (!ok || !rec?.is_active) {
    await recordAttempt(db(), rules, false);
    throw new DxError('INVALID_CREDENTIALS', 'Login ID or password is incorrect');
  }
  await recordAttempt(db(), rules, true);
  const token = newSessionToken();
  await db().rpc('create_admin_session', {
    p_user: rec.user_id, p_token_hash: hashToken(token), p_ttl_minutes: ADMIN_SESSION_MINUTES, p_ip: ip, p_ua: req.headers.get('user-agent') ?? '',
  });
  const res = json({ ok: true });
  setAdminCookie(res, token);
  return res;
});
