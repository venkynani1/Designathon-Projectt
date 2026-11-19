'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, download } from '@/components/api';
import { Alert, Badge, Button, Card, teamLabel } from '@/components/ui';
import { useAdmin } from '@/components/admin/AdminContext';
import { ArenaBar } from '@/components/admin/ArenaBar';
import { GoodiesTabs } from '@/components/admin/GoodiesTabs';

interface Choice { employee_id: string; name: string; goodie: string; chosen_at: string; registered: boolean; registered_name: string | null; email: string | null; team_number: number | null; team_name: string | null }
interface Pending { employee_id: string; name: string; email: string | null; department: string | null; team_number: number | null; team_name: string | null }
interface G { id: string; name: string; stock: number; reserved: number; is_active: boolean }
interface Report { choices: Choice[]; pending: Pending[]; goodies: G[]; meals?: { veg: number; nonveg: number; by_employee: Record<string, string> } }

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function SurveyPage() {
  const admin = useAdmin();
  const [data, setData] = useState<Report | null>(null);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'choices' | 'pending'>('choices');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState('');
  const load = useCallback(() => api<Report>('/api/admin/survey').then(setData).catch((e) => setErr(e.message)), []);
  useEffect(() => {
    setUrl(`${(process.env.NEXT_PUBLIC_APP_URL || window.location.origin).replace(/\/+$/, '')}/goodies`);
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const needle = q.trim().toLowerCase();
  const choices = useMemo(() => (data?.choices ?? []).filter((c) => !needle || `${c.employee_id} ${c.name} ${c.goodie} ${c.email ?? ''}`.toLowerCase().includes(needle)), [data, needle]);
  const pending = useMemo(() => (data?.pending ?? []).filter((p) => !needle || `${p.employee_id} ${p.name} ${p.email ?? ''}`.toLowerCase().includes(needle)), [data, needle]);
  const stock = data?.goodies.filter((g) => g.is_active).reduce((s, g) => s + g.stock, 0) ?? 0;
  const taken = data?.goodies.reduce((s, g) => s + g.reserved, 0) ?? 0;

  async function reset(c: Choice) {
    if (!window.confirm(`Clear ${c.name} (${c.employee_id})'s choice of ${c.goodie}?\n\nThe goodie goes back into stock and they can choose again.`)) return;
    setErr(''); setMsg('');
    try { await api(`/api/admin/survey/${encodeURIComponent(c.employee_id)}`, { method: 'DELETE' }); setMsg(`Cleared ${c.employee_id}.`); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-black">Goodies</h1>
        <Button variant="secondary" onClick={() => download('/api/admin/survey/export').catch((e) => setErr(e.message))}>Download Excel report</Button>
      </div>
      <GoodiesTabs />
      <ArenaBar arena="goodies" />
      {msg && <Alert tone="green">{msg}</Alert>}
      {err && <Alert>{err}</Alert>}

      <Card className="flex flex-col gap-4 sm:flex-row sm:items-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/api/admin/survey/qr" alt="Survey QR code" className="h-36 w-36 shrink-0 rounded-xl ring-1 ring-slate-200" />
        <div className="min-w-0 flex-1 space-y-2">
          <h2 className="font-bold">Put this in the email</h2>
          <p className="text-sm text-slate-600">One link for everyone. Participants enter their employee ID and name, pick a goodie and submit. Counts update live.</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="max-w-full truncate rounded-lg bg-slate-100 px-3 py-1.5 text-sm">{url}</code>
            <Button variant="secondary" onClick={async () => { try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* */ } }}>{copied ? 'Copied ✓' : 'Copy link'}</Button>
            <Button variant="secondary" onClick={() => download('/api/admin/survey/qr').catch((e) => setErr(e.message))}>Download QR image</Button>
            <a href={url} target="_blank" rel="noopener" className="text-sm font-semibold text-brand-700 hover:underline">Preview ↗</a>
          </div>
        </div>
      </Card>

      {data && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card><p className="text-sm text-slate-500">Responses</p><p className="text-3xl font-black">{data.choices.length}</p></Card>
          <Card><p className="text-sm text-slate-500">Registered, not chosen yet</p><p className="text-3xl font-black">{data.pending.length}</p></Card>
          <Card><p className="text-sm text-slate-500">Meals</p><p className="text-2xl font-black"><span className="text-emerald-700">{data.meals?.veg ?? 0} Veg</span> · <span className="text-rose-700">{data.meals?.nonveg ?? 0} Non-veg</span></p></Card>
          <Card><p className="text-sm text-slate-500">Goodies left</p><p className="text-3xl font-black">{Math.max(stock - taken, 0)} <span className="text-base font-medium text-slate-400">/ {stock}</span></p></Card>
        </div>
      )}

      {data && data.goodies.length > 0 && (
        <Card>
          <h2 className="mb-3 font-bold">Per goodie</h2>
          <div className="space-y-2">
            {data.goodies.map((g) => {
              const left = Math.max(g.stock - g.reserved, 0);
              return (
                <div key={g.id} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-sm">
                  <span className="truncate font-medium">{g.name}{!g.is_active && <span className="ml-1 text-xs text-slate-400">(hidden)</span>}</span>
                  <div className="h-2 overflow-hidden rounded bg-slate-100"><div className={`h-full ${left === 0 ? 'bg-rose-500' : 'bg-brand-500'}`} style={{ width: `${g.stock ? (g.reserved / g.stock) * 100 : 0}%` }} /></div>
                  <span className="tabular-nums text-slate-600">{g.reserved} / {g.stock} · <strong className={left === 0 ? 'text-rose-600' : ''}>{left === 0 ? 'none left' : `${left} left`}</strong></span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg bg-slate-100 p-0.5 text-sm font-semibold">
            <button className={`rounded-md px-3 py-1 ${tab === 'choices' ? 'bg-white shadow' : 'text-slate-500'}`} onClick={() => setTab('choices')}>Responses ({data?.choices.length ?? 0})</button>
            <button className={`rounded-md px-3 py-1 ${tab === 'pending' ? 'bg-white shadow' : 'text-slate-500'}`} onClick={() => setTab('pending')}>Not chosen yet ({data?.pending.length ?? 0})</button>
          </div>
          <input className="input ml-auto max-w-xs" placeholder="Search name, ID, goodie…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="overflow-x-auto">
          {tab === 'choices' ? (
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-slate-500"><tr><th className="py-2 pr-3">Employee ID</th><th className="pr-3">Name</th><th className="pr-3">Goodie</th><th className="pr-3">Meal</th><th className="pr-3">List</th><th className="pr-3">When</th><th /></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {choices.map((c) => (
                  <tr key={c.employee_id}>
                    <td className="py-2 pr-3 font-mono">{c.employee_id}</td>
                    <td className="pr-3">{c.name}{c.registered_name && c.registered_name.toLowerCase() !== c.name.toLowerCase() && <span className="block text-xs text-slate-400">registered as {c.registered_name}</span>}</td>
                    <td className="pr-3 font-medium">{c.goodie}</td>
                    <td className="pr-3">{({ veg: 'Veg', nonveg: 'Non-veg' } as Record<string, string>)[data?.meals?.by_employee[c.employee_id] ?? ''] ?? '—'}</td>
                    <td className="pr-3">{c.registered ? (c.team_number ? teamLabel(c.team_number) : '✓ in list') : <Badge tone="amber">Not in list</Badge>}</td>
                    <td className="whitespace-nowrap pr-3 text-slate-500">{when(c.chosen_at)}</td>
                    <td className="text-right">{admin.atLeast('admin') && <button className="text-xs font-semibold text-rose-700 hover:underline" onClick={() => reset(c)}>Clear</button>}</td>
                  </tr>
                ))}
                {choices.length === 0 && <tr><td colSpan={7} className="py-8 text-center text-slate-400">{data ? 'No responses yet.' : 'Loading…'}</td></tr>}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-slate-500"><tr><th className="py-2 pr-3">Employee ID</th><th className="pr-3">Name</th><th className="pr-3">Email</th><th className="pr-3">Team / dept.</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {pending.map((p) => (
                  <tr key={p.employee_id}><td className="py-2 pr-3 font-mono">{p.employee_id}</td><td className="pr-3">{p.name}</td><td className="pr-3 text-slate-500">{p.email ?? '—'}</td><td className="pr-3">{p.team_number ? teamLabel(p.team_number) : p.department ?? '—'}</td></tr>
                ))}
                {pending.length === 0 && <tr><td colSpan={4} className="py-8 text-center text-slate-400">Everyone registered has chosen.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </div>
  );
}
