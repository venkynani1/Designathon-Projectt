'use client';
import { useState } from 'react';
import { api, ApiError } from '@/components/api';
import { Alert, Badge, Button, Card, Field, teamLabel } from '@/components/ui';
import { useAdmin } from '@/components/admin/AdminContext';
import { RosterUpload } from '@/components/admin/RosterUpload';
import { OfflineUpload } from '@/components/admin/OfflineUpload';
import { TeamsUpload } from '@/components/admin/TeamsUpload';

interface Upload { id: string; headers: string[]; sample: Record<string, string>[]; row_count: number; fields: string[]; suggested_mapping: Record<string, string> }
interface Plan {
  teams: { team_id: string; team_number: number; team_name: string; members: { name: string; employee_id: string; email: string | null }[]; source_rows: number[]; assignment: string }[];
  errors: { rows: number[]; message: string }[];
  warnings: { rows: number[]; message: string }[];
  summary: { rows: number; teams: number; participants: number; by_size: Record<string, number> };
}

const LABEL = (f: string) => f.replace(/^p(\d)_/, 'P$1 ').replace('employee_id', 'employee ID').replace(/_/g, ' ');

export default function ImportPage() {
  const admin = useAdmin();
  const [format, setFormat] = useState<'team' | 'participant'>('participant');
  const [file, setFile] = useState<File | null>(null);
  const [up, setUp] = useState<Upload | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<Plan | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [result, setResult] = useState('');

  async function upload() {
    if (!file) return;
    setBusy('up'); setErr(''); setPlan(null); setResult('');
    const fd = new FormData();
    fd.append('file', file);
    fd.append('format', format);
    try {
      const res = await fetch('/api/admin/imports', { method: 'POST', body: fd });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error?.message ?? 'Upload failed');
      setUp(j);
      setMapping(j.suggested_mapping);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Upload failed'); } finally { setBusy(''); }
  }
  async function preview() {
    setBusy('pv'); setErr('');
    try { setPlan(await api<Plan>(`/api/admin/imports/${up!.id}/preview`, { body: { mapping } })); } catch (e) { setErr(e instanceof Error ? e.message : 'Preview failed'); } finally { setBusy(''); }
  }
  async function commit(privileged: boolean) {
    setBusy('cm'); setErr('');
    try {
      const r = await api<{ teams: unknown[] }>(`/api/admin/imports/${up!.id}/commit`, { body: { privileged, reason: privileged ? reason : null } });
      setResult(`Imported ${r.teams.length} teams. All slot PINs were preserved.`);
      setUp(null); setPlan(null); setFile(null);
    } catch (e) {
      setErr(e instanceof ApiError && e.code === 'FROZEN' ? 'Participant changes are frozen — a superadmin must commit with a reason.' : e instanceof Error ? e.message : 'Commit failed');
    } finally { setBusy(''); }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-black">Import</h1>
      <Card className="space-y-3">
        <div>
          <h2 className="text-lg font-bold">Participant list</h2>
          <p className="text-sm text-slate-600">Upload an Excel file with just <strong>Employee ID</strong> and <strong>Employee Name</strong>. These people can choose goodies, and their name fills in automatically from their ID.</p>
        </div>
        {admin.atLeast('admin') ? <RosterUpload /> : <Alert tone="amber">Only admins can upload the participant list.</Alert>}
        <a href="/admin/goodies/participants" className="inline-block text-sm font-semibold text-brand-700 hover:underline">View the participant list →</a>
      </Card>

      <Card className="space-y-3">
        <div>
          <h2 className="text-lg font-bold">Offline registrations</h2>
          <p className="text-sm text-slate-600">People who registered offline: upload <strong>Employee ID, Employee Name, Team Name, Veg/Non-veg and Goodie</strong>.
            Their goodie is booked straight away (counts drop), and they collect it at the desk with the same QR as everyone else.
            Leave Goodie empty to just add them to the list so they can choose with the goodies QR.</p>
        </div>
        {admin.atLeast('admin') ? <OfflineUpload /> : <Alert tone="amber">Only admins can upload offline registrations.</Alert>}
      </Card>

      <Card className="space-y-3">
        <div>
          <h2 className="text-lg font-bold">Teams (for the team-wise reports)</h2>
          <p className="text-sm text-slate-600">Upload <strong>Employee ID, Employee Name, Team Name</strong>. Teams are numbered Group 1, 2, 3… alphabetically by team name in the reports.
            These people are also added to the participant list.</p>
        </div>
        {admin.atLeast('admin') ? <TeamsUpload /> : <Alert tone="amber">Only admins can upload teams.</Alert>}
      </Card>

      <details className="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
        <summary className="cursor-pointer font-semibold text-slate-600">Team registration import (only needed for teams &amp; problem statements)</summary>
        <div className="mt-4 space-y-4">
      {result && <Alert tone="green">{result}</Alert>}
      {err && <Alert>{err}</Alert>}
      <Card className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="File format" hint={format === 'team' ? 'One row per team: team number/name, P1–P4 name, employee ID, email' : 'One row per participant, grouped by team number or team name'}>
            <select className="input" value={format} onChange={(e) => { setFormat(e.target.value as 'team' | 'participant'); setUp(null); setPlan(null); }}>
              <option value="participant">Participant-based (one row per person)</option>
              <option value="team">Team-based (one row per team)</option>
            </select>
          </Field>
          <Field label="CSV or XLSX (max 5 MB)"><input className="input" type="file" accept=".csv,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          <Button busy={busy === 'up'} disabled={!file} onClick={upload}>Upload</Button>
        </div>
      </Card>

      {up && (
        <Card className="space-y-4">
          <h2 className="font-bold">Map columns <span className="text-sm font-normal text-slate-500">({up.row_count} rows)</span></h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {up.fields.map((f) => (
              <Field key={f} label={LABEL(f)}>
                <select className="input" value={mapping[f] ?? ''} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value || undefined } as Record<string, string>)}>
                  <option value="">— not in file —</option>
                  {up.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </Field>
            ))}
          </div>
          <details className="text-sm"><summary className="cursor-pointer font-semibold">Sample rows</summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify(up.sample, null, 2)}</pre>
          </details>
          <Button busy={busy === 'pv'} onClick={preview}>Validate & preview</Button>
        </Card>
      )}

      {plan && (
        <Card className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Badge tone="blue">{plan.summary.teams} teams</Badge>
            <Badge tone="blue">{plan.summary.participants} participants</Badge>
            {Object.entries(plan.summary.by_size).map(([k, v]) => <Badge key={k}>{v} × {k}-person</Badge>)}
            <Badge tone={plan.errors.length ? 'red' : 'green'}>{plan.errors.length} errors</Badge>
            <Badge tone={plan.warnings.length ? 'amber' : 'slate'}>{plan.warnings.length} warnings</Badge>
          </div>
          {plan.errors.length > 0 && (
            <Alert><strong>Fix these in the file and re-upload — nothing has been imported:</strong>
              <ul className="mt-1 list-disc pl-5">{plan.errors.map((e, i) => <li key={i}>{e.rows.length ? `Row ${e.rows.join(', ')}: ` : ''}{e.message}</li>)}</ul>
            </Alert>
          )}
          {plan.warnings.length > 0 && <Alert tone="amber"><ul className="list-disc pl-5">{plan.warnings.map((e, i) => <li key={i}>{e.rows.length ? `Row ${e.rows.join(', ')}: ` : ''}{e.message}</li>)}</ul></Alert>}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-slate-500"><tr><th className="p-2">Team</th><th className="p-2">Name</th>{[1, 2, 3, 4].map((n) => <th key={n} className="p-2">P{n}</th>)}</tr></thead>
              <tbody className="divide-y">
                {plan.teams.map((t) => (
                  <tr key={t.team_id}>
                    <td className="p-2 font-mono">{teamLabel(t.team_number)} {t.assignment === 'auto' && <Badge>auto</Badge>}</td>
                    <td className="p-2 font-semibold">{t.team_name}</td>
                    {[0, 1, 2, 3].map((i) => <td key={i} className="p-2">{t.members[i] ? <>{t.members[i].name}<div className="font-mono text-xs text-slate-500">{t.members[i].employee_id}</div></> : <span className="text-slate-300">vacant</span>}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.errors.length === 0 && (
            <div className="flex flex-wrap items-end gap-3">
              <Button busy={busy === 'cm'} onClick={() => commit(false)}>Commit import</Button>
              {admin.isSuper && (
                <>
                  <input className="input max-w-sm" placeholder="Reason (only if edits are frozen)" value={reason} onChange={(e) => setReason(e.target.value)} />
                  <Button variant="secondary" disabled={reason.trim().length < 10} busy={busy === 'cm'} onClick={() => commit(true)}>Commit as privileged exception</Button>
                </>
              )}
            </div>
          )}
        </Card>
      )}
        </div>
      </details>
    </div>
  );
}
