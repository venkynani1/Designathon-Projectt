'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/admin/goodies', label: 'Goodies', hint: 'photos, names, counts' },
  { href: '/admin/goodies/participants', label: 'Participants', hint: 'employee IDs & names' },
  { href: '/admin/goodies/autopicks', label: 'Auto-picks', hint: 'instant picks by personal link' },
  { href: '/admin/survey', label: 'Link, QR & report', hint: 'share, live responses' },
];

/** The goodies hub: everything the organizer needs, in the order they need it. */
export function GoodiesTabs() {
  const path = usePathname();
  return (
    <nav className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {TABS.map((t, i) => {
        const on = path === t.href;
        return (
          <Link key={t.href} href={t.href}
            className={`flex items-center gap-3 rounded-2xl px-4 py-3 ring-1 transition ${on ? 'bg-brand-600 text-white ring-brand-600 shadow' : 'bg-white text-slate-700 ring-slate-200 hover:ring-brand-300'}`}>
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-black ${on ? 'bg-white/20' : 'bg-brand-50 text-brand-700'}`}>{i + 1}</span>
            <span className="min-w-0">
              <span className="block font-bold leading-tight">{t.label}</span>
              <span className={`block truncate text-xs ${on ? 'text-white/80' : 'text-slate-500'}`}>{t.hint}</span>
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
