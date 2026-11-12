'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, download } from '@/components/api';
import { Alert, Badge, Button, Field, Modal } from '@/components/ui';
import { useAdmin } from './AdminContext';
import { MemberModal } from './MemberModal';

interface Cred { id: string; status: 'active' | 'compromised'; version: number; disclosed_at: string | null; status_reason: string | null }
interface Slot {
  id: string; slot_number: number; occupancy: 'vacant' | 'occupied'; participant_name: string | null; employee_id: string | null; email: string | null;
  goodies_eligible: boolean; credential: Cred | null; reservation: { goodie: string; status: string } | null;
  history: { participant_name: string; employee_id: string; assigned_at: string; released_at: string | null; release_reason: string | null; reservation: string | null }[];
}
interface Detail {
  team: { id: string; team_number: number; name: string | null; registration_status: string; registration_source: string };
  team_credential: Cred | null;
  slots: Slot[];
  assignment: { code: string; title: string } | null;
  credentials: { credential_id: string; package_available: boolean }[];
}

export function CredBadge({ c }: { c: Cred | null }) {
  if (!c) return <Badge tone="red">No credential</Badge>;
  if (c.status === 'compromised') return <Badge tone="red">Compromised · reissue</Badge>;
  return <Badge tone={c.disclosed_at ? 'green' : 'slate'}>{c.disclosed_at ? 'Issued' : 'Not yet printed'}{c.version > 1 ? ` · v${c.version}` : ''}</Badge>;
}

export function TeamDetail({ teamId, frozen, onChanged }: { teamId: string; frozen: boolean; onChanged: () => void }) {
  const admin = useAdmin();
  const [d, setD] = useState<Detail | null>(null);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<{ tone: 'red' | 'green' | 'amber'; text: string } | null>(null);
  const [modal, setModal] = useState<{ mode: 'add' | 'replace' | 'remove'; slot?: Slot } | null>(null);
  const [edit, setEdit] = useState<Slot | null>(null);
  const [reissue, setReissue] = useState<{ ids: string[]; label: string } | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const r = await api<Detail>(`/api/admin/teams/${teamId}`);
    setD(r);
    setName(r.team.name ?? '');
  }, [teamId]);
  useEffect(() => { load().catch((e) => setMsg({ tone: 'red', text: e.message })); }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'green', text: ok });
      await load();
      onChanged();
    } catch (e) {
      setMsg({ tone: 'red', text: e instanceof Error ? e.message : 'Failed' });
    } finally {
      setBusy('');
    }
  };

  if (!d) return <p className="p-4 text-sm text-slate-500">Loading team…</p>;
  const hasVacant = d.slots.some((s) => s.occupancy === 'vacant');
  const anyCompromised = [d.team_credential, ...d.slots.map((s) => s.credential)].some((c) => c?.status === 'compromised');
  const pinsAvailable = d.credentials.some((c) => c.package_available);

  return (
    <div className="space-y-4 bg-slate-50 p-4">
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {anyCompromised && <Alert tone="amber">A PIN on this team was disclosed to someone who is no longer in the slot. It cannot be used until a superadmin reissues it.</Alert>}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] flex-1">
          <Field label="Team name (credentials never change on rename)">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={!admin.atLeast('registrar')} maxLength={60} />
          </Field>
        </div>
        {admin.atLeast('registrar') && (
          <Button variant="secondary" busy={busy === 'rename'} disabled={!name.trim() || name === d.team.name}
            onClick={() => run('rename', () => api(`/api/admin/teams/${teamId}`, { method: 'PATCH', body: { name } }), 'Team renamed — PINs, assignment and reservations unchanged.')}>
            Save name
          </Button>
        )}
        <div className="flex items-center gap-2 text-sm">
          <span className="text-slate-500">Team PIN</span><CredBadge c={d.team_credential} />
          {admin.isSuper && admin.can_issue_credentials && d.team_credential && (
            <button className="text-xs font-semibold text-rose-700 hover:underline" onClick={() => setReissue({ ids: [d.team_credential!.id], label: 'Team PIN' })}>Reissue</button>
          )}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {d.slots.map((s) => (
          <div key={s.id} className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
            <div className="flex items-center justify-between">
              <span className="text-lg font-black text-brand-700">P{s.slot_number}</span>
              <CredBadge c={s.credential} />
            </div>
            {s.occupancy === 'occupied' ? (
              <div className="mt-1">
                <div className="font-semibold">{s.participant_name}</div>
                <div className="font-mono text-xs text-slate-500">{s.employee_id}</div>
                {s.email && <div className="text-xs text-slate-500">{s.email}</div>}
                <div className="mt-2 flex flex-wrap gap-1">
                  {s.reservation ? <Badge tone="green">🎁 {s.reservation.goodie}</Badge> : <Badge>No goodie yet</Badge>}
                  {!s.goodies_eligible && <Badge tone="amber">Goodies ineligible</Badge>}
                </div>
              </div>
            ) : (
              <div className="mt-1 text-sm italic text-slate-400">Vacant — PIN reserved for this slot</div>
            )}
            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs font-semibold">
              {s.occupancy === 'occupied' && admin.atLeast('registrar') && (
                <>
                  <button className="text-brand-700 hover:underline" onClick={() => setEdit(s)}>Edit details</button>
                  <button className="text-brand-700 hover:underline" onClick={() => setModal({ mode: 'replace', slot: s })}>Replace</button>
                  <button className="text-rose-700 hover:underline" onClick={() => setModal({ mode: 'remove', slot: s })}>Remove</button>
                </>
              )}
              {s.occupancy === 'occupied' && admin.atLeast('admin') && (
                <button className="text-slate-600 hover:underline" onClick={() => {
                  const reason = window.prompt(`Reason for marking goodies ${s.goodies_eligible ? 'ineligible' : 'eligible'}:`);
                  if (reason && reason.trim().length >= 3) run('elig', () => api(`/api/admin/slots/${s.id}`, { body: { action: 'eligibility', eligible: !s.goodies_eligible, reason } }), 'Eligibility updated.');
                }}>{s.goodies_eligible ? 'Mark ineligible' : 'Mark eligible'}</button>
              )}
              {admin.isSuper && admin.can_issue_credentials && s.credential && (
                <button className="text-rose-700 hover:underline" onClick={() => setReissue({ ids: [s.credential!.id], label: `P${s.slot_number} PIN` })}>Reissue PIN</button>
              )}
            </div>
            {s.history.filter((h) => h.released_at).length > 0 && (
              <details className="mt-2 text-xs text-slate-500">
                <summary className="cursor-pointer">Previous occupants</summary>
                <ul className="mt-1 space-y-1">
                  {s.history.filter((h) => h.released_at).map((h) => (
                    <li key={h.assigned_at}>{h.participant_name} ({h.employee_id}) — left {new Date(h.released_at!).toLocaleString()} · {h.release_reason}{h.reservation ? ` · kept goodie: ${h.reservation}` : ''}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {hasVacant && admin.atLeast('registrar') && <Button onClick={() => setModal({ mode: 'add' })}>Add member</Button>}
        <Button variant="secondary" busy={busy === 'slip'} onClick={() => run('slip', () => download(`/api/admin/teams/${teamId}/slip`, { with_pins: false }), 'Registration slip downloaded (PINs masked).')}>Registration slip PDF</Button>
        {admin.can_issue_credentials && (
          <Button variant="secondary" busy={busy === 'cslip'} onClick={() => run('cslip', async () => {
            const r = await download(`/api/admin/teams/${teamId}/slip`, { with_pins: true });
            if (r.missing) throw new Error(`Slip downloaded, but ${r.missing} PIN(s) are no longer recoverable (package expired or credential compromised) and show "REISSUE".`);
          }, 'Credential slip downloaded. These PINs are now marked as issued.')}>
            Credential slip PDF {pinsAvailable ? '' : '(package expired)'}
          </Button>
        )}
        <span className="ml-auto text-sm text-slate-600">
          Problem: {d.assignment ? <strong>{d.assignment.code} — {d.assignment.title}</strong> : 'not selected'}
        </span>
        {admin.atLeast('admin') && <Link className="text-xs font-semibold text-brand-700 hover:underline" href={`/admin/audit?entity=${teamId}`}>Audit history</Link>}
      </div>

      <MemberModal
        open={!!modal} mode={modal?.mode ?? 'add'} frozen={frozen} isSuper={admin.isSuper}
        title={modal?.mode === 'add' ? 'Add participant' : modal?.mode === 'replace' ? `Replace P${modal.slot?.slot_number} (${modal.slot?.participant_name})` : `Remove P${modal?.slot?.slot_number} (${modal?.slot?.participant_name})`}
        note={modal?.mode === 'replace' ? 'The previous participant keeps any goodie they reserved; the replacement starts fresh. If the slot PIN was already printed it is withdrawn and must be reissued.' : modal?.mode === 'remove' ? 'The slot and its PIN are kept for a future participant. History is preserved.' : 'The participant takes the lowest vacant slot and its existing permanent PIN.'}
        onClose={() => setModal(null)}
        onSubmit={async ({ member, reason, privileged }) => {
          const m = modal!;
          const res = await (m.mode === 'add'
            ? api<{ slot_number: number; requires_reissue?: boolean }>(`/api/admin/teams/${teamId}/members`, { body: { member, privileged, reason: reason || null } })
            : api<{ requires_reissue?: boolean }>(`/api/admin/slots/${m.slot!.id}`, { body: m.mode === 'replace' ? { action: 'replace', member, reason, privileged } : { action: 'remove', reason, privileged } }));
          await load();
          onChanged();
          setMsg(res.requires_reissue
            ? { tone: 'amber', text: 'Saved. This slot’s PIN was previously disclosed — reissue it before handing it to the new participant.' }
            : { tone: 'green', text: 'Saved. Existing slot PINs were preserved.' });
        }}
      />

      <EditDetails slot={edit} onClose={() => setEdit(null)} onSave={(s, n, e) => run('edit', () => api(`/api/admin/slots/${s.id}`, { body: { action: 'update', name: n, email: e || null } }), 'Details updated — PIN unchanged.')} />

      <ReissueModal target={reissue} onClose={() => setReissue(null)} onDone={async () => { setReissue(null); await load(); onChanged(); setMsg({ tone: 'amber', text: 'New PIN issued. Print the credential slip now — the old PIN no longer works.' }); }} />
    </div>
  );
}

function EditDetails({ slot, onClose, onSave }: { slot: Slot | null; onClose: () => void; onSave: (s: Slot, name: string, email: string) => Promise<void> }) {
  const [n, setN] = useState('');
  const [e, setE] = useState('');
  useEffect(() => { if (slot) { setN(slot.participant_name ?? ''); setE(slot.email ?? ''); } }, [slot]);
  return (
    <Modal open={!!slot} title={`Edit P${slot?.slot_number} details`} onClose={onClose}>
      <div className="space-y-3">
        <Alert tone="blue">Spelling and email corrections only. To change the employee ID, use Replace (a different employee is a different identity).</Alert>
        <Field label="Name"><input className="input" value={n} onChange={(ev) => setN(ev.target.value)} /></Field>
        <Field label="Email"><input className="input" value={e} onChange={(ev) => setE(ev.target.value)} /></Field>
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={async () => { await onSave(slot!, n, e); onClose(); }}>Save</Button></div>
      </div>
    </Modal>
  );
}

function ReissueModal({ target, onClose, onDone }: { target: { ids: string[]; label: string } | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setReason(''); setErr(''); }, [target]);
  return (
    <Modal open={!!target} title={`Reissue ${target?.label}`} onClose={onClose}>
      <div className="space-y-3">
        <Alert tone="amber">This permanently retires the current PIN (it stops working immediately, signed-in devices are logged out) and issues a new one. Use only when the original can’t be recovered or was exposed.</Alert>
        <Field label="Reason (audited)"><textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {err && <Alert>{err}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="danger" busy={busy} disabled={reason.trim().length < 10} onClick={async () => {
            setBusy(true);
            setErr('');
            try { await api('/api/admin/credentials/reissue', { body: { credential_ids: target!.ids, reason } }); onDone(); }
            catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
            finally { setBusy(false); }
          }}>Reissue PIN</Button>
        </div>
      </div>
    </Modal>
  );
}
