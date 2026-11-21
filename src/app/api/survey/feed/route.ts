import { NextResponse } from 'next/server';
import { route } from '@/lib/http';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';

export const dynamic = 'force-dynamic';

/**
 * Public live goodie counts. Cached at Vercel's edge for 1s, so even 1000 phones
 * polling every few seconds cost the database roughly one query per second.
 */
export const GET = route(async () => {
  const ev = await currentEvent(db());
  await db().rpc('autopick_run_pending', { p_event: ev.id });
  const feed = await db().rpc('survey_feed', { p_event: ev.id });
  return NextResponse.json(feed, {
    headers: {
      'Cache-Control': 'public, max-age=0, s-maxage=5, stale-while-revalidate=5',
      'CDN-Cache-Control': 'public, s-maxage=5, stale-while-revalidate=5',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
