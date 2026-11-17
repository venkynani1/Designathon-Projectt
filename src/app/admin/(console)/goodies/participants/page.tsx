'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/components/api';
import { Alert, Badge, Button, Card, Field, Modal } from '@/components/ui';
import { useAdmin } from '@/components/admin/AdminContext';
import { GoodiesTabs } from '@/components/admin/GoodiesTabs';

interface Person { employee_id: string; name: string; email: string | null; department: string | null; goodie: string | null; chosen_at: string | null }
interface ImportResult { added: number; updated: number; total: number; skipped: { line: number; employee_id: string | null; name: string | null; problem: string }[] }
type Draft = { original?: string; employee_id: string; name: string; email: string; department: string };

const TEMPLATE = 'Employee ID,Name,Email,Department\nEMP1001,Asha Rao,asha.rao@company.com,Design\nEMP1002,Ravi Kumar,,Engineering\n';

export default function ParticipantsPage() {
  const admin = useAdmin();
  const canEdit = admin.atLeast('admin');
  const [people, setPeople] = useState<Person[] | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'chosen' | 'pending'>('all');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [paste, setPaste] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => api<{ people: Person[] }>('/api/admin/roster').then((r) => setPeople(r.people)).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  async function upload(data: { file?: File; text?: string }) {
    if (replace && people?.length && !window.confirm(`Replace the whole list (${people.length} people) with this upload?`)) return;
    setBusy(true); setErr(''); setMsg(''); setResult(null);
    try {
      const fd = new FormData();
      if (data.file) fd.append('file', data.file);
      if (data.text) fd.append('text', data.text);
      if (replace) fd.append('replace', '1');
      const res = await fetch('/api/admin/roster/import', { method: 'POST', body: fd, credentials: 'same-origin' });
      const j = await res.json();
      if (!res.ok) throw new ApiError(j?.error?.code ?? 'HTTP', j?.error?.message ?? 'Upload failed', res.status);
      setResult(j as ImportResult);
      setPaste(''); setShowPaste(false);
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Upload failed'); } finally { setBusy(false); }
  }

  async function save() {
    if (!edit) return;
    setBusy(true); setErr('');
    try {
      await api('/api/admin/roster', { body: { ...edit, email: edit.email || null, department: edit.department || null, original: edit.original ?? null } });
      setMsg(edit.original ? 'Saved.' : `${edit.name} added.`); setEdit(null); await load();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); } finally { setBusy(false); }
  }
  async function remove(p: Person) {
    if (!window.confirm(`Remove ${p.name} (${p.employee_id}) from the list?${p.goodie ? `\n\nTheir choice (${p.goodie}) stays in the report.` : ''}`)) return;
    setErr(''); setMsg('');
    try { await api(`/api/admin/roster/${encodeURIComponent(p.employee_id)}`, { method: 'DELETE' }); setMsg('Removed.'); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
  }
  async function clearAll() {
    if (!window.confirm(`Remove ALL ${people?.length ?? 0} people from the list?\n\nGoodies already chosen are kept. Anyone could then choose again with any employee ID until you upload a new list.`)) return;
    try { const r = await api<{ removed: number }>('/api/admin/roster', { method: 'DELETE' }); setMsg(`Removed ${r.removed} people.`); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
  }
  function template() {
    const url = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'participants-template.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => (people ?? []).filter((p) =>
    (filter === 'all' || (filter === 'chosen' ? !!p.goodie : !p.goodie)) &&
    (!needle || `${p.employee_id} ${p.name} ${p.email ?? ''} ${p.department ?? ''} ${p.goodie ?? ''}`.toLowerCase().includes(needle))), [people, needle, filter]);
  const chosen = people?.filter((p) => p.goodie).length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-black">Goodies</h1>
        {canEdit && <Button onClick={() => { setErr(''); setEdit({ employee_id: '', name: '', email: '', department: '' }); }}>+ Add person</Button>}
      </div>
      <GoodiesTabs />
      {msg && <Alert tone="green">{msg}</Alert>}
      {err && <Alert>{err}</Alert>}

      {people && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Card><p className="text-sm text-slate-500">In the participant list</p><p className="text-3xl font-black">{people.length}</p></Card>
          <Card><p className="text-sm text-slate-500">Chose a goodie</p><p className="text-3xl font-black text-emerald-700">{chosen}</p></Card>
          <Card><p className="text-sm text-slate-500">Not chosen yet</p><p className="text-3xl font-black text-amber-600">{people.length - chosen}</p></Card>
        </div>
      )}

      {canEdit && (
        <Card>
          <div className="flex flex-wrap items-start gap-3">
            <div className="mr-auto">
              <h2 className="font-bold">Upload the participant list</h2>
              <p className="text-sm text-slate-600">Excel (.xlsx) or CSV with columns <strong>Employee ID</strong> and <strong>Name</strong> (Email and Department optional).
                When someone types their employee ID in the survey, their name fills in automatically.</p>
            </div>
            <button type="button" onClick={template} className="text-sm font-semibold text-brand-700 hover:underline">Download template</button>
          </div>
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) upload({ file: f }); }}
            className={`mt-3 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition ${drag ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-slate-50'}`}>
            <p className="text-3xl">📄</p>
            <p className="text-sm text-slate-600">Drag the file here, or</p>
            <Button busy={busy} onClick={() => fileRef.current?.click()}>Choose file</Button>
            <input ref={fileRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload({ file: f }); }} />
            <button type="button" className="text-xs font-semibold text-slate-500 hover:underline" onClick={() => setShowPaste((v) => !v)}>…or paste the list instead</button>
          </div>
          {showPaste && (
            <div className="mt-3 space-y-2">
              <textarea className="input h-40 font-mono text-sm" value={paste} onChange={(e) => setPaste(e.target.value)}
                placeholder={'One person per line, e.g.\nEMP1001, Asha Rao\nEMP1002, Ravi Kumar'} />
              <Button busy={busy} disabled={!paste.trim()} onClick={() => upload({ text: paste })}>Add these people</Button>
            </div>
          )}
          <label className="mt-3 flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            Replace the whole list (otherwise new people are added and existing ones updated)
          </label>
          {result && (
            <div className="mt-3 space-y-2">
              <Alert tone="green">{result.added} added · {result.updated} updated · {result.total} people in the list now{result.skipped.length ? ` · ${result.skipped.length} rows skipped` : ''}</Alert>
              {result.skipped.length > 0 && (
                <div className="max-h-48 overflow-auto rounded-xl bg-amber-50 p-3 text-sm ring-1 ring-amber-200">
                  <p className="mb-1 font-semibold text-amber-900">Skipped rows — fix them in the file and upload again:</p>
                  <ul className="space-y-0.5 text-amber-900">
                    {result.skipped.map((s) => <li key={s.line}>Row {s.line + 1}: {s.employee_id || '(no ID)'} {s.name ? `· ${s.name}` : ''} — {s.problem}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg bg-slate-100 p-0.5 text-sm font-semibold">
            {(['all', 'pending', 'chosen'] as const).map((f) => (
              <button key={f} className={`rounded-md px-3 py-1 ${filter === f ? 'bg-white shadow' : 'text-slate-500'}`} onClick={() => setFilter(f)}>
                {f === 'all' ? 'Everyone' : f === 'pending' ? 'Not chosen' : 'Chosen'}
              </button>
            ))}
          </div>
          <input className="input ml-auto max-w-xs" placeholder="Search ID, name, email…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr><th className="py-2 pr-3">Employee ID</th><th className="pr-3">Name</th><th className="pr-3">Email</th><th className="pr-3">Department</th><th className="pr-3">Goodie</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shown.slice(0, 500).map((p) => (
                <tr key={p.employee_id}>
                  <td className="py-2 pr-3 font-mono">{p.employee_id}</td>
                  <td className="pr-3 font-medium">{p.name}</td>
                  <td className="pr-3 text-slate-500">{p.email ?? '—'}</td>
                  <td className="pr-3 text-slate-500">{p.department ?? '—'}</td>
                  <td className="pr-3">{p.goodie ? <Badge tone="green">{p.goodie}</Badge> : <span className="text-slate-400">Not yet</span>}</td>
                  <td className="whitespace-nowrap text-right">
                    {canEdit && <>
                      <button className="mr-3 text-xs font-semibold text-brand-700 hover:underline" onClick={() => { setErr(''); setEdit({ original: p.employee_id, employee_id: p.employee_id, name: p.name, email: p.email ?? '', department: p.department ?? '' }); }}>Edit</button>
                      <button className="text-xs font-semibold text-rose-700 hover:underline" onClick={() => remove(p)}>Remove</button>
                    </>}
                  </td>
                </tr>
              ))}
              {people && shown.length === 0 && (
                <tr><td colSpan={6} className="py-10 text-center text-slate-400">
                  {people.length === 0 ? 'No participants yet. Upload the list above — until then anyone can choose by typing their ID and name.' : 'Nobody matches.'}
                </td></tr>
              )}
              {!people && <tr><td colSpan={6} className="py-10 text-center text-slate-400">Loading…</td></tr>}
            </tbody>
          </table>
          {shown.length > 500 && <p className="pt-2 text-xs text-slate-500">Showing 500 of {shown.length} — search to narrow down.</p>}
        </div>
        {canEdit && !!people?.length && <div className="mt-4 text-right"><button className="text-xs font-semibold text-rose-700 hover:underline" onClick={clearAll}>Remove everyone from the list</button></div>}
      </Card>

      <Modal open={!!edit} title={edit?.original ? `Edit ${edit.name}` : 'Add person'} onClose={() => setEdit(null)}>
        {edit && (
          <form onSubmit={(e) => { e.preventDefault(); save(); }} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Employee ID"><input className="input font-mono" value={edit.employee_id} onChange={(e) => setEdit({ ...edit, employee_id: e.target.value.toUpperCase().replace(/\s/g, '') })} required maxLength={40} autoFocus /></Field>
              <Field label="Name"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required maxLength={100} /></Field>
              <Field label="Email (optional)"><input className="input" type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} maxLength={200} /></Field>
              <Field label="Department (optional)"><input className="input" value={edit.department} onChange={(e) => setEdit({ ...edit, department: e.target.value })} maxLength={100} /></Field>
            </div>
            {err && <Alert>{err}</Alert>}
            <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button busy={busy}>Save</Button></div>
          </form>
        )}
      </Modal>
    </div>
  );
}
