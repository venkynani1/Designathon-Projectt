'use client';
import { useEffect, useState } from 'react';
import { api, download } from '@/components/api';
import { Alert, Button, Card, Field, teamLabel } from '@/components/ui';
import { useAdmin } from '@/components/admin/AdminContext';

interface Row { id: string; team_number: number; registration_status: string; occupied: number }
interface Summary { event: { goodies_open: boolean; member_edits_frozen: boolean } }
const blank = () => ({ name: '', employee_id: '', email: '' });

export default function WalkIn() {
  const admin = useAdmin();
  const [free, setFree] = useState<Row[]>([]);
  const [teamId, setTeamId] = useState('');
  const [teamName, setTeamName] = useState('');
  const [members, setMembers] = useState([blank(), blank()]);
  const [frozen, setFrozen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<{ team_id: string; team_number: number; name: string; slots: { slot_number: number; name: string; requires_reissue: boolean }[] } | null>(null);

  async function loadFree() {
    const [{ teams }, s] = await Promise.all([api<{ teams: Row[] }>('/api/admin/teams?q='), api<Summary>('/api/admin/summary')]);
    const f = teams.filter((t) => t.registration_status === 'unregistered' && t.occupied === 0);
    setFree(f);
    setTeamId((cur) => (f.some((t) => t.id === cur) ? cur : f[0]?.id ?? ''));
    setFrozen(s.event.member_edits_frozen);
  }
  useEffect(() => { loadFree().catch((e) => setErr(e.message)); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const res = await api<NonNullable<typeof done>>('/api/admin/walk-in', {
        body: { team_id: teamId, team_name: teamName, members: members.filter((m) => m.name || m.employee_id), privileged: frozen, reason: frozen ? reason : null },
      });
      setDone(res);
      setTeamName('');
      setMembers([blank(), blank()]);
      setReason('');
      await loadFree();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  const set = (i: number, k: 'name' | 'employee_id' | 'email', v: string) => setMembers(members.map((m, j) => (j === i ? { ...m, [k]: v } : m)));

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-black">Walk-in registration</h1>
      {done && (
        <Alert tone="green">
          <div><strong>{teamLabel(done.team_number)} — {done.name}</strong> registered: {done.slots.map((s) => `P${s.slot_number} ${s.name}`).join(', ')}. Existing PINs retained.</div>
          {done.slots.some((s) => s.requires_reissue) && <div className="mt-1 font-semibold text-amber-800">A slot PIN here needs reissue before handing out.</div>}
          <div className="mt-2 flex gap-2">
            {admin.can_issue_credentials && <Button onClick={() => download(`/api/admin/teams/${done.team_id}/slip`, { with_pins: true }).catch((e) => setErr(e.message))}>Print credential slip</Button>}
            <Button variant="secondary" onClick={() => download(`/api/admin/teams/${done.team_id}/slip`, { with_pins: false }).catch((e) => setErr(e.message))}>Registration slip</Button>
          </div>
        </Alert>
      )}
      {frozen && <Alert tone="amber">Participant changes are frozen. {admin.isSuper ? 'A walk-in now is a privileged exception — give a reason.' : 'Only a superadmin can register teams now.'}</Alert>}
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Unused team number" hint={`${free.length} unused pre-generated teams`}>
              <select className="input" value={teamId} onChange={(e) => setTeamId(e.target.value)} required>
                {free.map((t) => <option key={t.id} value={t.id}>{teamLabel(t.team_number)}</option>)}
              </select>
            </Field>
            <Field label="Team name"><input className="input" value={teamName} onChange={(e) => setTeamName(e.target.value)} required minLength={2} maxLength={60} placeholder="Design Ninjas" /></Field>
          </div>
          {members.map((m, i) => (
            <div key={i} className="grid gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-[3rem_1fr_1fr_1fr_auto] sm:items-end">
              <div className="text-lg font-black text-brand-700">P{i + 1}</div>
              <Field label="Name"><input className="input" value={m.name} onChange={(e) => set(i, 'name', e.target.value)} required={i < 2} /></Field>
              <Field label="Employee ID"><input className="input font-mono" value={m.employee_id} onChange={(e) => set(i, 'employee_id', e.target.value)} required={i < 2} /></Field>
              <Field label="Email (optional)"><input className="input" type="email" value={m.email} onChange={(e) => set(i, 'email', e.target.value)} /></Field>
              {i >= 2 ? <Button type="button" variant="ghost" onClick={() => setMembers(members.filter((_, j) => j !== i))}>✕</Button> : <span />}
            </div>
          ))}
          {members.length < 4 && <Button type="button" variant="secondary" onClick={() => setMembers([...members, blank()])}>+ Add P{members.length + 1}</Button>}
          {frozen && <Field label="Reason for privileged registration"><textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} required /></Field>}
          {err && <Alert>{err}</Alert>}
          <Button className="w-full" busy={busy} disabled={!teamId || (frozen && !admin.isSuper)}>Register team</Button>
        </form>
      </Card>
    </div>
  );
}
