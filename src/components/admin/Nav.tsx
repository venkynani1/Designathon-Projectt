'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAdmin } from './AdminContext';

const LINKS = [
  { href: '/admin', label: 'Registrations', min: 'viewer' },
  { href: '/admin/problems', label: 'Problem statements', min: 'viewer' },
  { href: '/admin/goodies', label: 'Goodies', min: 'viewer' },
  { href: '/admin/walk-in', label: 'Walk-in', min: 'registrar' },
  { href: '/admin/import', label: 'Import', min: 'registrar' },
  { href: '/admin/provision', label: 'Teams & credentials', min: 'admin' },
  { href: '/admin/settings', label: 'Event controls', min: 'admin' },
  { href: '/admin/audit', label: 'Audit log', min: 'admin' },
] as const;

export function Nav() {
  const path = usePathname();
  const router = useRouter();
  const admin = useAdmin();
  return (
    <header className="no-print sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <span className="font-black tracking-tight text-brand-700">Designathon X</span>
        <nav className="flex flex-wrap gap-1">
          {LINKS.filter((l) => admin.atLeast(l.min)).map((l) => (
            <Link key={l.href} href={l.href} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${path === l.href ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100'}`}>{l.label}</Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs text-slate-500">
          <span>{admin.email} · {admin.role}{admin.can_issue_credentials ? ' · issuer' : ''}</span>
          <button className="font-semibold text-slate-700 hover:underline" onClick={async () => { await fetch('/api/admin/logout', { method: 'POST' }).catch(() => undefined); router.replace('/admin/login'); }}>Sign out</button>
        </div>
      </div>
    </header>
  );
}
