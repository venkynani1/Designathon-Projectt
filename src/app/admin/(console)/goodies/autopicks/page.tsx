'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/components/api';
import { Alert, Badge, Button, Card, Field, Modal } from '@/components/ui';
import { useAdmin } from '@/components/admin/AdminContext';
import { GoodiesTabs } from '@/components/admin/GoodiesTabs';

interface AutoPick { employee_id: string; name: string; token: string; prefs: string[]; pref_names: string[] | null; goodie: string | null; failed: boolean; chosen_at: string | null }
interface Goodie { id: string; name: string; stock: number; reserved: number; is_active: boolean }
type Draft = { employee_id: string; name: string; prefs: string[]; editing?: boolean };

export default function AutoPicksPage() {
  const admin = useAdmin();
  const canEdit = admin.atLeast('admin');
  const [rows, setRows] = useState<AutoPick[] | null>(null);
  const [goodies, setGoodies] = useState<Goodie[]>([]);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const [origin, setOrigin] = useState('');

  const load = useCallback(async () => {
    try {
      const [a, g] = await Promise.all([api<{ autopicks: AutoPick[] }>('/api/admin/autopicks'), api<{ goodies: Goodie[] }>('/api/admin/goodies')]);
      setRows(a.autopicks); setGoodies(g.goodies);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
  }, []);
  useEffect(() => { setOrigin((process.env.NEXT_PUBLIC_APP_URL || window.location.origin).replace(/\/+$/, '')); load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  const link = (t: string) => `${origin}/goodies/a/${t}`;
  async function copy(text: string, key: string) {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(''), 2000); } catch { /* */ }
  }
  async function save() {
    if (!edit) return;
    setBusy(true); setErr('');
    try {
      const r = await api<{ token: string }>('/api/admin/autopicks', { body: { employee_id: edit.employee_id, name: edit.name, prefs: edit.prefs } });
      setEdit(null); await load();
      void r;
      setMsg('Saved. Their goodie will be assigned on the first scan after choosing opens.');
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); } finally { setBusy(false); }
  }
  async function remove(a: AutoPick) {
    if (!window.confirm(`Remove the auto-pick for ${a.name}? Their link stops working.${a.goodie ? `\n\nThey keep the ${a.goodie} they already got.` : ''}`)) return;
    try { await api(`/api/admin/autopicks/${encodeURIComponent(a.employee_id)}`, { method: 'DELETE' }); await load(); } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
  }
  const togglePref = (id: string) => setEdit((d) => d && ({ ...d, prefs: d.prefs.includes(id) ? d.prefs.filter((x) => x !== id) : [...d.prefs, id] }));
  const allLinks = rows?.map((r) => `${r.name} (${r.employee_id}): ${link(r.token)}`).join('\n') ?? '';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-black">Goodies</h1>
        {canEdit && <Button onClick={() => { setErr(''); setEdit({ employee_id: '', name: '', prefs: [] }); }}>+ Add auto-pick</Button>}
      </div>
      <GoodiesTabs />
      <Card>
        <h2 className="font-bold">How auto-picks work</h2>
        <p className="mt-1 text-sm text-slate-600">
          Add people with their preferred goodies in order. Once choosing is open, the <strong>first time anyone opens the goodies link or QR</strong>,
          everyone on this list is given their goodie automatically — before any other pick is processed. They don’t need to do anything.
          Counts drop for everyone right away, and every assignment is recorded in the audit log and the report.
          If a 1st choice has run out, the 2nd is used, and so on. Each person also has an optional link to see what they got.
        </p>
        {!!allLinks && <Button className="mt-3" variant="secondary" onClick={() => copy(allLinks, '__all')}>{copied === '__all' ? 'Copied ✓' : 'Copy everyone’s status links'}</Button>}
      </Card>
      {msg && <Alert tone="green">{msg}</Alert>}
      {err && <Alert>{err}</Alert>}

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr><th className="py-2 pr-3">Employee ID</th><th className="pr-3">Name</th><th className="pr-3">Preferences</th><th className="pr-3">Status</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows?.map((a) => (
                <tr key={a.employee_id}>
                  <td className="py-2 pr-3 font-mono">{a.employee_id}</td>
                  <td className="pr-3 font-medium">{a.name}</td>
                  <td className="pr-3 text-slate-600">{(a.pref_names ?? []).map((n, i) => `${i + 1}. ${n}`).join('  ')}</td>
                  <td className="pr-3">{a.goodie ? <Badge tone="green">Assigned: {a.goodie}</Badge> : a.failed ? <Badge tone="red">None left — edit preferences</Badge> : <Badge tone="amber">Waiting for first scan</Badge>}</td>
                  <td className="whitespace-nowrap text-right">
                    <button className="mr-3 text-xs font-semibold text-brand-700 hover:underline" onClick={() => copy(link(a.token), a.employee_id)}>{copied === a.employee_id ? 'Copied ✓' : 'Status link'}</button>
                    {canEdit && !a.goodie && <button className="mr-3 text-xs font-semibold text-slate-700 hover:underline" onClick={() => { setErr(''); setEdit({ employee_id: a.employee_id, name: a.name, prefs: a.prefs, editing: true }); }}>Edit</button>}
                    {canEdit && <button className="text-xs font-semibold text-rose-700 hover:underline" onClick={() => remove(a)}>Remove</button>}
                  </td>
                </tr>
              ))}
              {rows && rows.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-slate-400">No auto-picks yet.</td></tr>}
              {!rows && <tr><td colSpan={5} className="py-10 text-center text-slate-400">Loading…</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal open={!!edit} title={edit?.editing ? `Edit ${edit.name}` : 'Add auto-pick'} onClose={() => setEdit(null)}>
        {edit && (
          <form onSubmit={(e) => { e.preventDefault(); save(); }} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Employee ID"><input className="input font-mono" value={edit.employee_id} disabled={edit.editing} onChange={(e) => setEdit({ ...edit, employee_id: e.target.value.toUpperCase().replace(/\s/g, '') })} required maxLength={40} autoFocus /></Field>
              <Field label="Name" hint="Leave empty to use the participant list"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={100} /></Field>
            </div>
            <Field label="Preferred goodies — tap in order (1st, 2nd…)">
              <div className="flex flex-wrap gap-2">
                {goodies.filter((g) => g.is_active).map((g) => {
                  const i = edit.prefs.indexOf(g.id);
                  return (
                    <button type="button" key={g.id} onClick={() => togglePref(g.id)}
                      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold ring-1 ${i >= 0 ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-700 ring-slate-300'}`}>
                      {i >= 0 && <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/25 text-xs">{i + 1}</span>}
                      {g.name} <span className={i >= 0 ? 'text-white/70' : 'text-slate-400'}>· {Math.max(g.stock - g.reserved, 0)} left</span>
                    </button>
                  );
                })}
              </div>
            </Field>
            {err && <Alert>{err}</Alert>}
            <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button busy={busy} disabled={!edit.prefs.length || edit.employee_id.length < 2}>Save & copy link</Button></div>
          </form>
        )}
      </Modal>
    </div>
  );
}
