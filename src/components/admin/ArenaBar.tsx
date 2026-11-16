'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/components/api';
import { Badge, Button } from '@/components/ui';
import { useAdmin } from './AdminContext';

/** Arena status + Open/Close + "Show QR screen", shown at the top of the content pages. */
export function ArenaBar({ arena }: { arena: 'problems' | 'goodies' }) {
  const admin = useAdmin();
  const key = arena === 'problems' ? 'problems_open' : 'goodies_open';
  const [open, setOpen] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ event: Record<string, boolean> }>('/api/admin/summary').then((s) => setOpen(s.event[key])).catch(() => undefined), [key]);
  useEffect(() => { load(); }, [load]);
  const label = arena === 'problems' ? 'Problem Statement Arena' : 'Goodies survey';
  const noun = arena === 'problems' ? 'arena' : 'survey';
  async function toggle() {
    const next = !open;
    if (!window.confirm(`${next ? 'OPEN' : 'CLOSE'} the ${label}?`)) return;
    setBusy(true);
    try { const r = await api<Record<string, boolean>>('/api/admin/event-flags', { body: { [key]: next } }); setOpen(r[key]); } finally { setBusy(false); }
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
      <span className="font-semibold">{label}</span>
      {open === null ? null : <Badge tone={open ? 'green' : 'slate'}>{open ? 'OPEN' : 'Closed'}</Badge>}
      <div className="ml-auto flex gap-2">
        <a href={`/admin/screen/${arena}`} target="_blank" rel="noopener" className="inline-flex items-center rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white hover:bg-slate-700">Show QR screen ↗</a>
        {admin.atLeast('admin') && open !== null && (
          <Button variant={open ? 'danger' : 'primary'} busy={busy} onClick={toggle}>{open ? `Close ${noun}` : `Open ${noun}`}</Button>
        )}
      </div>
    </div>
  );
}
