import { NextResponse } from 'next/server';
import { route } from '@/lib/http';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';

/**
 * Public team directory for the login picker: registered teams' number + name only.
 * Cached at Vercel's edge for 15 s per query so hundreds of people typing at once
 * don't each hit the database.
 */
export const GET = route(async (req) => {
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 60);
  const ev = await currentEvent(db());
  const teams = await db().rpc('arena_team_directory', { p_event: ev.id, p_q: q });
  return NextResponse.json({ teams }, {
    headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30', 'X-Content-Type-Options': 'nosniff' },
  });
});
