import { NextResponse } from 'next/server';
import { route } from '@/lib/http';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';

export const dynamic = 'force-dynamic';

/**
 * Public live goodie counts. Cached at Vercel's edge for 2s, so even 1000 phones
 * polling every few seconds cost the database roughly one query per 2 seconds.
 */
export const GET = route(async () => {
  const ev = await currentEvent(db());
  const feed = await db().rpc('survey_feed', { p_event: ev.id });
  return NextResponse.json(feed, {
    headers: {
      'Cache-Control': 'public, max-age=0, s-maxage=2, stale-while-revalidate=4',
      'CDN-Cache-Control': 'public, s-maxage=2, stale-while-revalidate=4',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
