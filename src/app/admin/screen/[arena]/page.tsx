import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { currentAdmin } from '@/lib/auth/admin';
import { QrScreen } from '@/components/admin/QrScreen';

export const dynamic = 'force-dynamic';

const ARENAS = {
  problems: { title: 'Problem Statement Arena', subtitle: 'Scan, pick your team and enter your Team PIN', path: '/arena/problems' },
  goodies: { title: 'Choose your goodie', subtitle: 'Scan, enter your Employee ID and name, pick a goodie', path: '/goodies' },
} as const;

/** Full-screen projector view: a large QR to the arena + Open/Close control + live counts. */
export default async function Screen({ params }: { params: Promise<{ arena: string }> }) {
  const { arena } = await params;
  if (arena !== 'problems' && arena !== 'goodies') notFound();
  const admin = await currentAdmin().catch(() => null);
  if (!admin) redirect(`/admin/login?next=/admin/screen/${arena}`);
  const h = await headers();
  const base = process.env.NEXT_PUBLIC_APP_URL || `https://${h.get('x-forwarded-host') ?? h.get('host')}`;
  const url = `${base.replace(/\/$/, '')}${ARENAS[arena].path}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0f172a', light: '#ffffff' } });
  return <QrScreen arena={arena} title={ARENAS[arena].title} subtitle={ARENAS[arena].subtitle} url={url} svg={svg} canToggle={admin.role === 'admin' || admin.role === 'superadmin'} />;
}
