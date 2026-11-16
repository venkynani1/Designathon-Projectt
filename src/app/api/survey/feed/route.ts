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
  const feed = await db().rpc('survey_feed', { p_event: ev.id });
  return NextResponse.json(feed, {
    headers: {
      'Cache-Control': 'public, max-age=0, s-maxage=1, stale-while-revalidate=1',
      'CDN-Cache-Control': 'public, s-maxage=1, stale-while-revalidate=1',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
