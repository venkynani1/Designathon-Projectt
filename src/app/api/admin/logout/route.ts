import { cookies } from 'next/headers';
import { route, json } from '@/lib/http';
import { db } from '@/lib/server/db';
import { hashToken } from '@/lib/crypto/tokens';
import { ADMIN_COOKIE, clearAdminCookie } from '@/lib/auth/admin';

export const POST = route(async () => {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  if (token) await db().rpc('revoke_admin_session', { p_token_hash: hashToken(token) });
  const res = json({ ok: true });
  clearAdminCookie(res);
  return res;
});
