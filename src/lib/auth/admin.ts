import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';
import { db } from '../server/db';
import { hashToken } from '../crypto/tokens';
import { authorize, type AdminUser, type Requirement } from './roles';

export const ADMIN_COOKIE = 'dx_admin_session';
export const ADMIN_SESSION_MINUTES = 12 * 60;

/** Resolves the httpOnly admin session cookie against the database on every request. */
export async function currentAdmin(): Promise<AdminUser | null> {
  const token = (await cookies()).get(ADMIN_COOKIE)?.value;
  if (!token || token.length > 100) return null;
  return db().rpc<AdminUser | null>('resolve_admin_session', { p_token_hash: hashToken(token) });
}

export async function requireAdmin(req: Requirement): Promise<AdminUser> {
  return authorize(await currentAdmin(), req);
}

export function setAdminCookie(res: NextResponse, token: string) {
  res.cookies.set(ADMIN_COOKIE, token, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: ADMIN_SESSION_MINUTES * 60,
  });
}

export function clearAdminCookie(res: NextResponse) {
  res.cookies.set(ADMIN_COOKIE, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 });
}
