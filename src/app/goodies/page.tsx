import type { Metadata } from 'next';
import { GoodiesSurvey } from '@/components/GoodiesSurvey';

export const metadata: Metadata = { title: 'Choose your goodie · Gen AI Designathon' };

/**
 * Static page served from Vercel's CDN — opening it never touches the database,
 * so hundreds of people can open it at once. Live counts load from the cached feed.
 */
export default function Page() {
  return <GoodiesSurvey />;
}
