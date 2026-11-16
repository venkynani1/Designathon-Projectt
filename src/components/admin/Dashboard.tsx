'use client';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, download } from '@/components/api';
import { Alert, Badge, Button, Card, teamLabel } from '@/components/ui';
import { TeamDetail } from './TeamDetail';

interface Row {
  id: string; team_number: number; name: string | null; registration_source: string; registration_status: string;
  occupied: number; assignment: { code: string; title: string } | null; reservations: number; compromised: number; undisclosed: number;
}
interface Summary {
  event: { name: string; problems_open: boolean; goodies_open: boolean; member_edits_frozen: boolean };
  teams_total: number; teams_registered: number; teams_incomplete: number; teams_unregistered: number;
  slots_occupied: number; slots_vacant: number; assignments: number; reservations: number;
  credentials_compromised: number; credentials_undisclosed: number; packages_available: number;
}

const SOURCE: Record<string, string> = { pregenerated: '—', online_import: 'Online', walk_in: 'Walk-in', admin: 'Admin' };
const STATUS_TONE: Record<string, 'green' | 'amber' | 'slate' | 'red'> = { registered: 'green', incomplete: 'amber', unregistered: 'slate', withdrawn: 'red' };

export function Dashboard() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [sum, setSum] = useState<Summary | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async (query: string) => {
    try {
      const [t, s] = await Promise.all([api<{ teams: Row[] }>(`/api/admin/teams?q=${encodeURIComponent(query)}`), api<Summary>('/api/admin/summary')]);
      setRows(t.teams);
      setSum(s);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load');
    }
  }, []);
  useEffect(() => {
    const h = setTimeout(() => load(q), 250);
    return () => clearTimeout(h);
  }, [q, load]);

  const frozen = !!sum && sum.event.member_edits_frozen;
  const stat = (label: string, value: number | string, sub?: string) => (
    <Card className="!p-4"><div className="text-xs font-semibold uppercase text-slate-500">{label}</div><div className="text-2xl font-black">{value}</div>{sub && <div className="text-xs text-slate-500">{sub}</div>}</Card>
  );

  return (
    <div className="space-y-5">
      {err && <Alert>{err}</Alert>}
      {sum && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="mr-auto text-2xl font-black">{sum.event.name} — registrations</h1>
            <Badge tone={sum.event.problems_open ? 'green' : 'slate'}>Problem Arena {sum.event.problems_open ? 'open' : 'closed'}</Badge>
            <Badge tone={sum.event.goodies_open ? 'green' : 'slate'}>Goodies survey {sum.event.goodies_open ? 'open' : 'closed'}</Badge>
            {frozen && <Badge tone="amber">Participant edits frozen</Badge>}
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            {stat('Registered teams', `${sum.teams_registered}/${sum.teams_total}`, `${sum.teams_incomplete} incomplete · ${sum.teams_unregistered} unused`)}
            {stat('Participants', sum.slots_occupied, `${sum.slots_vacant} vacant slots`)}
            {stat('Problems locked', sum.assignments)}
            {stat('Goodies reserved', sum.reservations)}
            {stat('PINs not yet printed', sum.credentials_undisclosed)}
            {stat('PINs needing reissue', sum.credentials_compromised)}
          </div>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <input className="input max-w-md" placeholder="Search team number, team name, participant name or employee ID" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button variant="secondary" onClick={() => download('/api/admin/report').catch((e) => setErr(e.message))}>Export Excel</Button>
      </div>
      <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>{['Team', 'Team name', 'Source', 'Slots', 'Status', 'Problem', 'Goodies', 'Credentials', ''].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows?.map((r) => (
              <Fragment key={r.id}>
                <tr className={`cursor-pointer hover:bg-brand-50/40 ${open === r.id ? 'bg-brand-50/60' : ''}`} onClick={() => setOpen(open === r.id ? null : r.id)}>
                  <td className="whitespace-nowrap px-3 py-2 font-mono font-semibold">{teamLabel(r.team_number)}</td>
                  <td className="px-3 py-2 font-medium">{r.name ?? <span className="text-slate-400">—</span>}</td>
                  <td className="px-3 py-2">{SOURCE[r.registration_source]}</td>
                  <td className="px-3 py-2">{r.occupied}/4</td>
                  <td className="px-3 py-2"><Badge tone={STATUS_TONE[r.registration_status]}>{r.registration_status}</Badge></td>
                  <td className="px-3 py-2">{r.assignment ? <span title={r.assignment.title}>{r.assignment.code}</span> : <span className="text-slate-400">—</span>}</td>
                  <td className="px-3 py-2">{r.occupied ? `${r.reservations}/${r.occupied}` : '—'}</td>
                  <td className="px-3 py-2">{r.compromised ? <Badge tone="red">{r.compromised} to reissue</Badge> : r.undisclosed ? <Badge>{r.undisclosed} unprinted</Badge> : <Badge tone="green">issued</Badge>}</td>
                  <td className="px-3 py-2 text-right text-brand-700">{open === r.id ? '▲' : '▼'}</td>
                </tr>
                {open === r.id && (
                  <tr><td colSpan={9} className="p-0"><TeamDetail teamId={r.id} frozen={frozen} onChanged={() => load(q)} /></td></tr>
                )}
              </Fragment>
            ))}
            {rows && rows.length === 0 && <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-500">No teams match. Generate teams under “Teams & credentials”.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
