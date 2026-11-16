'use client';
import { useEffect, useState } from 'react';
import { api } from '@/components/api';
import { Alert, Button, Card } from '@/components/ui';
import { useAdmin } from '@/components/admin/AdminContext';

type Flags = { problems_open: boolean; goodies_open: boolean; member_edits_frozen: boolean };

const ITEMS: { key: keyof Flags; title: string; on: string; off: string; warn?: string }[] = [
  { key: 'problems_open', title: 'Problem Statement Arena', on: 'Teams can lock problem statements', off: 'Teams can browse but not lock' },
  { key: 'goodies_open', title: 'Goodies survey', on: 'Participants can choose goodies', off: 'Survey closed', warn: undefined },
  { key: 'member_edits_frozen', title: 'Freeze participant changes', on: 'Add / remove / replace need a superadmin privileged exception', off: 'Registrars can change participants' },
];

export default function Settings() {
  const admin = useAdmin();
  const [flags, setFlags] = useState<Flags | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => { api<{ event: Flags }>('/api/admin/summary').then((s) => setFlags(s.event)).catch((e) => setErr(e.message)); }, []);
  async function toggle(k: keyof Flags) {
    const next = !flags![k];
    const item = ITEMS.find((i) => i.key === k)!;
    if (!window.confirm(`${next ? 'Turn ON' : 'Turn OFF'}: ${item.title}?${next && item.warn ? `\n\n${item.warn}` : ''}`)) return;
    setBusy(k); setErr('');
    try { setFlags(await api<Flags>('/api/admin/event-flags', { body: { [k]: next } })); } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); } finally { setBusy(''); }
  }
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-black">Event controls</h1>
      <div className="grid gap-3 sm:grid-cols-2">
        <a href="/admin/screen/problems" target="_blank" rel="noopener" className="rounded-2xl bg-slate-900 p-4 text-white hover:bg-slate-700"><div className="text-xs uppercase tracking-wide opacity-70">Projector</div><div className="font-bold">Problem Arena QR screen ↗</div></a>
        <a href="/admin/screen/goodies" target="_blank" rel="noopener" className="rounded-2xl bg-slate-900 p-4 text-white hover:bg-slate-700"><div className="text-xs uppercase tracking-wide opacity-70">Projector</div><div className="font-bold">Goodies Arena QR screen ↗</div></a>
      </div>
      {err && <Alert>{err}</Alert>}
      {flags && ITEMS.map((i) => (
        <Card key={i.key} className="flex items-center justify-between gap-4">
          <div><h2 className="font-bold">{i.title}</h2><p className="text-sm text-slate-600">{flags[i.key] ? i.on : i.off}</p></div>
          <Button variant={flags[i.key] ? 'danger' : 'primary'} busy={busy === i.key} disabled={!admin.atLeast('admin')} onClick={() => toggle(i.key)}>
            {flags[i.key] ? 'Turn off' : 'Turn on'}
          </Button>
        </Card>
      ))}
    </div>
  );
}
