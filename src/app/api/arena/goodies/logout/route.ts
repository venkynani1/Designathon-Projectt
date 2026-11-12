import { route, json } from '@/lib/http';
import { db } from '@/lib/supabase/server';
import { clearSessionCookie, sessionToken } from '@/lib/arenaSession';
import { hashToken } from '@/lib/crypto/tokens';

export const POST = route(async () => {
  const token = await sessionToken('participant');
  if (token) await db().rpc('revoke_arena_session', { p_token_hash: hashToken(token) });
  const res = json({ ok: true });
  clearSessionCookie(res, 'participant');
  return res;
});
