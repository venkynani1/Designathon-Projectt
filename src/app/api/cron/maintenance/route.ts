import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { db } from '@/lib/server/db';
import { env } from '@/lib/env';

export const runtime = 'nodejs';

/** Vercel Cron: destroys expired credential packages, expires sessions, trims the rate-limit ledger. */
export async function GET(req: NextRequest) {
  const got = Buffer.from(req.headers.get('authorization') ?? '');
  const want = Buffer.from(`Bearer ${env.cronSecret()}`);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const purged = await db().rpc<number>('purge_expired_packages', {});
  return NextResponse.json({ purged });
}
