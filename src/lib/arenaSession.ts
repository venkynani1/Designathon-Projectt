import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';
import type { Db } from './db';
import { DxError } from './errors';
import { resolveArenaSession, type ResolvedSession } from './services/arenaAuth';

export const COOKIE = { team: 'dx_team_session', participant: 'dx_participant_session' } as const;

export function setSessionCookie(res: NextResponse, kind: keyof typeof COOKIE, token: string, maxAge: number) {
  res.cookies.set(COOKIE[kind], token, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge,
  });
}

export function clearSessionCookie(res: NextResponse, kind: keyof typeof COOKIE) {
  res.cookies.set(COOKIE[kind], '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 });
}

export async function sessionToken(kind: keyof typeof COOKIE): Promise<string | undefined> {
  return (await cookies()).get(COOKIE[kind])?.value;
}

/** Re-validated against the database on every request (works across refreshes and devices). */
export async function requireArenaSession(db: Db, kind: keyof typeof COOKIE): Promise<ResolvedSession> {
  const s = await resolveArenaSession(db, kind, await sessionToken(kind));
  if (!s) throw new DxError('SESSION_INVALID', 'Your session has ended. Please sign in again.');
  return s;
}
