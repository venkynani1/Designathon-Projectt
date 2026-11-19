import type { Metadata } from 'next';
import { GoodiesSurvey, type Feed } from '@/components/GoodiesSurvey';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';

export const metadata: Metadata = { title: 'Choose your goodie · Gen AI Designathon' };
export const dynamic = 'force-dynamic';

/** Goodies are rendered on the server, so the page shows counts instantly — no loading spinner. */
export default async function Page() {
  let initial: Feed | null = null;
  try {
    const ev = await currentEvent(db());
    await db().rpc('autopick_run_pending', { p_event: ev.id });
    initial = await db().rpc<Feed>('survey_feed', { p_event: ev.id });
  } catch { /* the client fetches it */ }
  return <GoodiesSurvey initial={initial} />;
}
