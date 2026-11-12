'use client';
import { useEffect, useState } from 'react';
import { Alert, Button, Field, Modal } from '@/components/ui';

export interface MemberInput { name: string; employee_id: string; email: string }

/**
 * Shared modal for add / replace / remove. When participant edits are frozen, only a
 * superadmin may proceed, and must give a reason (privileged exception workflow).
 */
export function MemberModal(props: {
  open: boolean;
  mode: 'add' | 'replace' | 'remove';
  title: string;
  frozen: boolean;
  isSuper: boolean;
  onClose: () => void;
  onSubmit: (v: { member?: MemberInput; reason: string; privileged: boolean }) => Promise<void>;
  note?: string;
}) {
  const [m, setM] = useState<MemberInput>({ name: '', employee_id: '', email: '' });
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (props.open) { setM({ name: '', employee_id: '', email: '' }); setReason(''); setErr(''); }
  }, [props.open]);
  const needsReason = props.mode !== 'add' || props.frozen;
  const blocked = props.frozen && !props.isSuper;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await props.onSubmit({ member: props.mode === 'remove' ? undefined : m, reason, privileged: props.frozen });
      props.onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={props.open} title={props.title} onClose={props.onClose}>
      <form onSubmit={submit} className="space-y-3">
        {props.frozen && (
          <Alert tone="amber">
            Participant changes are frozen (Goodies Arena open or edits frozen). {props.isSuper ? 'This will be recorded as a privileged exception.' : 'Only a superadmin can make this change.'}
          </Alert>
        )}
        {props.note && <Alert tone="blue">{props.note}</Alert>}
        {props.mode !== 'remove' && (
          <>
            <Field label="Participant name"><input className="input" value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} required maxLength={120} /></Field>
            <Field label="Employee ID"><input className="input font-mono" value={m.employee_id} onChange={(e) => setM({ ...m, employee_id: e.target.value })} required maxLength={40} /></Field>
            <Field label="Corporate email (optional)"><input className="input" type="email" value={m.email} onChange={(e) => setM({ ...m, email: e.target.value })} maxLength={200} /></Field>
          </>
        )}
        {needsReason && (
          <Field label="Reason (recorded in audit log)" hint="At least 10 characters for replacements and privileged changes.">
            <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={props.mode === 'remove' && !props.frozen ? 3 : 10} maxLength={500} />
          </Field>
        )}
        {err && <Alert>{err}</Alert>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={props.onClose}>Cancel</Button>
          <Button busy={busy} disabled={blocked} variant={props.mode === 'remove' ? 'danger' : 'primary'}>
            {props.mode === 'add' ? 'Add to next vacant slot' : props.mode === 'replace' ? 'Replace participant' : 'Remove participant'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
