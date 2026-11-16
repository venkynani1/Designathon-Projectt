import type { Metadata } from 'next';
import { GoodiesSurvey } from '@/components/GoodiesSurvey';

export const metadata: Metadata = { title: 'Choose your goodie · Designathon X' };

export default function Page() {
  return <GoodiesSurvey />;
}
