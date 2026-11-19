import type { Metadata } from 'next';
import { AutoPick } from '@/components/AutoPick';

export const metadata: Metadata = { title: 'Your goodie · Gen AI Designathon', robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  return <AutoPick token={(await params).token} />;
}
