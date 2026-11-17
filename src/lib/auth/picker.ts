import { cookies } from 'next/headers';
import type { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DxError } from '../errors';
import { env } from '../env';
import { requireAdmin } from './admin';

/** Second lock for the organizer's Picker section: console login + DX_PICKER_PASSWORD. */
export const PICKER_COOKIE = 'dx_picker';
const HOURS = 12;

const sign = (userId: string, exp: number) =>
  createHmac('sha256', env.pinPepper()).update(`picker:v1:${userId}:${exp}`).digest('base64url');

export function pickerPasswordOk(given: string): boolean {
  const want = process.env.DX_PICKER_PASSWORD ?? '';
  if (!want) return false;
  const a = createHmac('sha256', 'cmp').update(given).digest();
  const b = createHmac('sha256', 'cmp').update(want).digest();
  return timingSafeEqual(a, b);
}

export function setPickerCookie(res: NextResponse, userId: string) {
  const exp = Math.floor(Date.now() / 1000) + HOURS * 3600;
  res.cookies.set(PICKER_COOKIE, `${exp}.${sign(userId, exp)}`, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: HOURS * 3600,
  });
}

export async function pickerUnlocked(userId: string): Promise<boolean> {
  const v = (await cookies()).get(PICKER_COOKIE)?.value ?? '';
  const [expS, sig] = v.split('.');
  const exp = Number(expS);
  if (!sig || !Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const want = Buffer.from(sign(userId, exp));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

export async function requirePicker() {
  const admin = await requireAdmin({ role: 'admin' });
  if (!(await pickerUnlocked(admin.user_id))) throw new DxError('FORBIDDEN', 'Picker is locked');
  return admin;
}
