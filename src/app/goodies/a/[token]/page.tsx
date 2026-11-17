import type { Metadata } from 'next';
import { AutoPick } from '@/components/AutoPick';

export const metadata: Metadata = { title: 'Your goodie · Designathon X', robots: { index: false } };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  return <AutoPick token={(await params).token} />;
}
