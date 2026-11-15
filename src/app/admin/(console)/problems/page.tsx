'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/components/api';
import { Alert, Badge, Button, Field, Modal } from '@/components/ui';
import { useAdmin } from '@/components/admin/AdminContext';
import { ArenaBar } from '@/components/admin/ArenaBar';

interface Problem { id: string; code: string; title: string; summary: string | null; capacity: number; document_url: string | null; is_active: boolean; sort_order: number; taken: number }
type Draft = { id?: string; code: string; title: string; summary: string; capacity: number; document_url: string; is_active: boolean; sort_order?: number };
const empty = (n: number): Draft => ({ code: `PS-${String(n).padStart(2, '0')}`, title: '', summary: '', capacity: 5, document_url: '', is_active: true });

export default function ProblemsPage() {
  const admin = useAdmin();
  const [rows, setRows] = useState<Problem[] | null>(null);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ problems: Problem[] }>('/api/admin/problems').then((r) => setRows(r.problems)).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  const canEdit = admin.atLeast('admin');

  async function save() {
    if (!edit) return;
    setBusy(true); setErr('');
    try {
      await api('/api/admin/problems', { body: { ...edit, document_url: edit.document_url || null, summary: edit.summary || null } });
      setMsg(edit.id ? 'Saved.' : 'Problem statement added.');
      setEdit(null);
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); } finally { setBusy(false); }
  }
  async function quick(p: Problem, patch: Partial<Draft>, done: string) {
    setErr(''); setMsg('');
    try { await api('/api/admin/problems', { body: { ...p, summary: p.summary, document_url: p.document_url, ...patch } }); setMsg(done); await load(); } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
  }
  async function remove(p: Problem) {
    if (!window.confirm(`Delete ${p.code} — ${p.title}? This cannot be undone.`)) return;
    setErr(''); setMsg('');
    try { await api(`/api/admin/problems/${p.id}`, { method: 'DELETE' }); setMsg('Deleted.'); await load(); } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
  }
  async function move(i: number, dir: -1 | 1) {
    if (!rows) return;
    const a = rows[i], b = rows[i + dir];
    if (!b) return;
    await quick(a, { sort_order: b.sort_order }, 'Reordered.');
    await quick(b, { sort_order: a.sort_order }, 'Reordered.');
  }

  const totalCap = rows?.filter((r) => r.is_active).reduce((s, r) => s + r.capacity, 0) ?? 0;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-black">Problem statements</h1>
        {canEdit && <Button onClick={() => { setErr(''); setEdit(empty((rows?.length ?? 0) + 1)); }}>+ Add problem statement</Button>}
      </div>
      <ArenaBar arena="problems" />
      {msg && <Alert tone="green">{msg}</Alert>}
      {err && <Alert>{err}</Alert>}
      {rows && <p className="text-sm text-slate-600">{rows.filter((r) => r.is_active).length} visible · room for {totalCap} teams in total · {rows.reduce((s, r) => s + r.taken, 0)} locked so far</p>}
      <div className="space-y-3">
        {rows?.map((p, i) => (
          <div key={p.id} className={`rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200 ${p.is_active ? '' : 'opacity-60'}`}>
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-bold text-brand-700">{p.code}</span>
                  {!p.is_active && <Badge>Hidden</Badge>}
                  <Badge tone={p.taken >= p.capacity ? 'red' : 'blue'}>{p.taken} / {p.capacity} teams</Badge>
                </div>
                <h2 className="mt-1 font-bold">{p.title}</h2>
                {p.summary && <p className="mt-1 text-sm text-slate-600">{p.summary}</p>}
                {p.document_url && <a className="mt-1 inline-block text-sm font-semibold text-brand-700 hover:underline" href={p.document_url} target="_blank" rel="noopener noreferrer">Document ↗</a>}
              </div>
              {canEdit && (
                <div className="flex flex-wrap gap-1 text-xs font-semibold">
                  <Button variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</Button>
                  <Button variant="ghost" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label="Move down">↓</Button>
                  <Button variant="secondary" onClick={() => { setErr(''); setEdit({ ...p, summary: p.summary ?? '', document_url: p.document_url ?? '' }); }}>Edit</Button>
                  <Button variant="secondary" onClick={() => quick(p, { is_active: !p.is_active }, p.is_active ? 'Hidden from teams.' : 'Visible to teams.')}>{p.is_active ? 'Hide' : 'Show'}</Button>
                  {p.taken === 0 && <Button variant="ghost" className="text-rose-700" onClick={() => remove(p)}>Delete</Button>}
                </div>
              )}
            </div>
          </div>
        ))}
        {rows && rows.length === 0 && <p className="rounded-2xl bg-white p-8 text-center text-slate-500 ring-1 ring-slate-200">No problem statements yet. Add the first one.</p>}
      </div>

      <Modal open={!!edit} title={edit?.id ? `Edit ${edit.code}` : 'Add problem statement'} onClose={() => setEdit(null)}>
        {edit && (
          <form onSubmit={(e) => { e.preventDefault(); save(); }} className="space-y-3">
            <div className="grid grid-cols-[8rem_1fr] gap-3">
              <Field label="Code"><input className="input font-mono uppercase" value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value })} required maxLength={20} /></Field>
              <Field label="Title"><input className="input" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} required minLength={2} maxLength={160} /></Field>
            </div>
            <Field label="Short description (shown to teams)"><textarea className="input" rows={3} value={edit.summary} onChange={(e) => setEdit({ ...edit, summary: e.target.value })} maxLength={2000} /></Field>
            <div className="grid grid-cols-[10rem_1fr] gap-3">
              <Field label="Max teams"><input className="input" type="number" min={1} max={10000} value={edit.capacity} onChange={(e) => setEdit({ ...edit, capacity: Number(e.target.value) })} required /></Field>
              <Field label="Document link (optional)" hint="Google Drive / SharePoint / any https link"><input className="input" type="url" placeholder="https://…" value={edit.document_url} onChange={(e) => setEdit({ ...edit, document_url: e.target.value })} /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> Visible to teams</label>
            {err && <Alert>{err}</Alert>}
            <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button busy={busy}>Save</Button></div>
          </form>
        )}
      </Modal>
    </div>
  );
}
