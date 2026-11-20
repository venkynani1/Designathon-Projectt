import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DxError } from '../errors';
import { env } from '../env';
import type { Db } from '../db';

/** Distribution desk session: distributor's name + shared desk PIN. Changing the PIN signs everyone out. */
export const DESK_COOKIE = 'dx_desk';
const HOURS = 14;

const sign = (body: string) => createHmac('sha256', env.pinPepper()).update(`desk:v1:${body}`).digest('base64url');

export function setDeskCookie(res: NextResponse, eventId: string, version: number, name: string, finished = false) {
  const exp = Math.floor(Date.now() / 1000) + HOURS * 3600;
  const body = Buffer.from(JSON.stringify({ e: eventId, v: version, n: name, x: exp, f: finished })).toString('base64url');
  res.cookies.set(DESK_COOKIE, `${body}.${sign(body)}`, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: HOURS * 3600,
  });
}

export function clearDeskCookie(res: NextResponse) {
  res.cookies.set(DESK_COOKIE, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 });
}

export async function currentDesk(db: Db, eventId: string): Promise<{ name: string; finished: boolean; version: number } | null> {
  const raw = (await cookies()).get(DESK_COOKIE)?.value ?? '';
  const [body, sig] = raw.split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let p: { e: string; v: number; n: string; x: number; f?: boolean };
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (p.e !== eventId || p.x < Date.now() / 1000) return null;
  const version = await db.rpc<number | null>('desk_pin_version', { p_event: eventId });
  if (version !== p.v) return null;
  return { name: p.n, finished: !!p.f, version: p.v };
}

/** Signed-in distributor. Finished distributors can only download the attendance file. */
export async function requireDesk(db: Db, eventId: string, opts: { allowFinished?: boolean } = {}) {
  const d = await currentDesk(db, eventId);
  if (!d) throw new DxError('UNAUTHORIZED', 'Sign in to the desk again');
  if (d.finished && !opts.allowFinished) throw new DxError('FORBIDDEN', 'You have finished distributing. Sign in again to continue.');
  return d;
}
