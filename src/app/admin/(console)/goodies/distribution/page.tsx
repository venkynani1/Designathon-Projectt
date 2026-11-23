'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, download } from '@/components/api';
import { Alert, Button, Card } from '@/components/ui';
import { useAdmin } from '@/components/admin/AdminContext';
import { GoodiesTabs } from '@/components/admin/GoodiesTabs';

interface Summary { collected: number; total: number; in_queue: number; by_goodie: { name: string; chosen: number; collected: number }[] }
interface Data { summary: Summary; desk: { pin: string; version: number } | null; default_goodie?: { goodie_id: string | null; name: string | null; left: number | null } }

export default function DistributionPage() {
  const admin = useAdmin();
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');
  const [origin, setOrigin] = useState('');
  const load = useCallback(() => api<Data>('/api/admin/distribution').then(setD).catch((e) => setErr(e.message)), []);
  useEffect(() => { setOrigin((process.env.NEXT_PUBLIC_APP_URL || window.location.origin).replace(/\/+$/, '')); load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  const deskUrl = `${origin}/desk`;
  async function copy(text: string, k: string) { try { await navigator.clipboard.writeText(text); setCopied(k); setTimeout(() => setCopied(''), 2000); } catch { /* */ } }
  async function newPin() {
    const pin = window.prompt('New desk PIN (4–8 digits). Every distributor will be signed out and must sign in with the new PIN.', '');
    if (pin === null) return;
    try { await api('/api/admin/distribution/pin', { body: { pin: pin.trim() } }); await load(); } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
  }
  const [goodies, setGoodies] = useState<{ id: string; name: string; is_active: boolean }[]>([]);
  useEffect(() => { api<{ goodies: { id: string; name: string; is_active: boolean }[] }>('/api/admin/goodies').then((r) => setGoodies(r.goodies)).catch(() => undefined); }, []);
  async function setDefault(id: string) {
    try { await api('/api/admin/distribution/default', { body: { goodie_id: id || null } }); await load(); } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
  }
  const s = d?.summary;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-black">Goodies</h1>
      <GoodiesTabs />
      {err && <Alert>{err}</Alert>}
      <Card className="space-y-3">
        <h2 className="text-lg font-bold">Distribution desk</h2>
        <p className="text-sm text-slate-600">
          Give the distribution team the desk link and PIN. Each distributor opens it on their own phone or laptop and signs in with their name.
          The desk shows <strong>one QR</strong>: participants scan it, enter their employee ID and see their goodie on their phone.
          They appear instantly in a <strong>shared queue</strong> for every distributor; whoever hands it over taps <strong>Collected</strong>.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm">{deskUrl}</code>
          <Button variant="secondary" onClick={() => copy(deskUrl, 'url')}>{copied === 'url' ? 'Copied ✓' : 'Copy desk link'}</Button>
          <a href="/desk" target="_blank" rel="noopener" className="text-sm font-semibold text-brand-700 hover:underline">Open desk ↗</a>
        </div>
        {d?.desk && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-slate-600">Desk PIN:</span>
            <span className="rounded-lg bg-slate-900 px-3 py-1.5 font-mono text-lg font-bold tracking-widest text-white">{d.desk.pin}</span>
            <Button variant="secondary" onClick={() => copy(`Goodie desk: ${deskUrl}\nPIN: ${d.desk!.pin}`, 'pin')}>{copied === 'pin' ? 'Copied ✓' : 'Copy link + PIN'}</Button>
            {admin.atLeast('admin') && <button className="text-xs font-semibold text-rose-700 hover:underline" onClick={newPin}>Change PIN</button>}
          </div>
        )}
      </Card>
      <Card className="space-y-2">
        <h2 className="font-bold">No response? Default goodie</h2>
        <p className="text-sm text-slate-600">People in the participant list who never responded get this goodie when they scan at the desk (or are looked up). They choose Veg / Non-veg on the spot.</p>
        <div className="flex flex-wrap items-center gap-3">
          <select className="input max-w-xs" value={d?.default_goodie?.goodie_id ?? ''} disabled={!admin.atLeast('admin')} onChange={(e) => setDefault(e.target.value)}>
            <option value="">None — no default goodie</option>
            {goodies.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          {d?.default_goodie?.name && <span className="text-sm text-slate-600">{d.default_goodie.left} left</span>}
        </div>
      </Card>
      {s && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card><p className="text-sm text-slate-500">Collected</p><p className="text-3xl font-black text-emerald-700">{s.collected} <span className="text-base font-medium text-slate-400">/ {s.total}</span></p></Card>
          <Card><p className="text-sm text-slate-500">Waiting at the desk</p><p className="text-3xl font-black text-amber-600">{s.in_queue}</p></Card>
          <Card><p className="text-sm text-slate-500">Still to collect</p><p className="text-3xl font-black">{s.total - s.collected}</p></Card>
        </div>
      )}
      {s && s.by_goodie.length > 0 && (
        <Card>
          <h2 className="mb-3 font-bold">Per goodie</h2>
          <div className="space-y-2">
            {s.by_goodie.map((g) => (
              <div key={g.name} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-sm">
                <span className="truncate font-medium">{g.name}</span>
                <div className="h-2 overflow-hidden rounded bg-slate-100"><div className="h-full bg-emerald-500" style={{ width: `${g.chosen ? (g.collected / g.chosen) * 100 : 0}%` }} /></div>
                <span className="tabular-nums text-slate-600">{g.collected} / {g.chosen} collected</span>
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card className="flex flex-wrap items-center gap-3">
        <div className="mr-auto"><h2 className="font-bold">Attendance</h2><p className="text-sm text-slate-600">Team-wise present / absent (present = collected their goodie) and leftover goodies.</p></div>
        <Button onClick={() => download('/api/admin/attendance').catch((e) => setErr(e.message))}>Download attendance</Button>
      </Card>
      <p className="text-sm text-slate-500">Download the Excel report from <a href="/admin/survey" className="font-semibold text-brand-700 hover:underline">Link, QR &amp; report</a> — it includes Collected at and Collected by.</p>
    </div>
  );
}
