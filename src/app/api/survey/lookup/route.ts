import { NextResponse } from 'next/server';
import { route } from '@/lib/http';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { DxError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/** Public: employee ID → name (and whether they already chose). Exact match only. */
export const GET = route(async (req) => {
  const emp = (req.nextUrl.searchParams.get('emp') ?? '').trim();
  if (emp.length < 2 || emp.length > 40) throw new DxError('INVALID_INPUT', 'Enter your employee ID');
  const ev = await currentEvent(db());
  // Short CDN cache per employee ID: repeat lookups don't hit the database; submit re-checks everything anyway.
  return NextResponse.json(await db().rpc('survey_lookup', { p_event: ev.id, p_employee_id: emp }), {
    headers: { 'Cache-Control': 'public, max-age=0, s-maxage=3, stale-while-revalidate=5', 'CDN-Cache-Control': 'public, s-maxage=3, stale-while-revalidate=5', 'X-Content-Type-Options': 'nosniff' },
  });
});
