import { redirect } from 'next/navigation';
import { currentAdmin } from '@/lib/auth/admin';
import { AdminProvider } from '@/components/admin/AdminContext';
import { Nav } from '@/components/admin/Nav';

export const dynamic = 'force-dynamic';

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const admin = await currentAdmin().catch(() => null);
  if (!admin) redirect('/admin/login');
  return (
    <AdminProvider admin={admin}>
      <Nav />
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </AdminProvider>
  );
}
