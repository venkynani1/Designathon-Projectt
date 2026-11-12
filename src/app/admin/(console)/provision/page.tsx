'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, download } from '@/components/api';
import { Alert, Badge, Button, Card, Field, Modal } from '@/components/ui';
import { useAdmin } from '@/components/admin/AdminContext';

interface Pkg { id: string; purpose: string; credential_count: number; created_at: string; expires_at: string; purged_at: string | null; available: boolean; download_count: number; team_numbers: number[] | null }
interface Summary { teams_total: number; credentials_undisclosed: number; credentials_compromised: number }

const range = (nums: number[] | null) => {
  if (!nums?.length) return '';
  const s = [...nums].sort((a, b) => a - b);
  const p = (n: number) => String(n).padStart(3, '0');
  return s.length === 1 ? p(s[0]) : `${p(s[0])}–${p(s[s.length - 1])}${s.length !== s[s.length - 1] - s[0] + 1 ? ' (selected)' : ''}`;
};

export default function Provision() {
  const admin = useAdmin();
  const [sum, setSum] = useState<Summary | null>(null);
  const [pkgs, setPkgs] = useState<Pkg[]>([]);
  const [count, setCount] = useState(50);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ tone: 'green' | 'red' | 'amber'; text: string } | null>(null);

  const load = useCallback(async () => {
    const [s, p] = await Promise.all([api<Summary>('/api/admin/summary'), api<{ packages: Pkg[] }>('/api/admin/packages')]);
    setSum(s);
    setPkgs(p.packages);
    if (s.teams_total > 0) setCount((c) => (c === 50 ? 10 : c));
  }, []);
  useEffect(() => { load().catch((e) => setMsg({ tone: 'red', text: e.message })); }, [load]);

  const act = async (key: string, fn: () => Promise<string>) => {
    setBusy(key); setMsg(null);
    try { setMsg({ tone: 'green', text: await fn() }); await load(); } catch (e) { setMsg({ tone: 'red', text: e instanceof Error ? e.message : 'Failed' }); } finally { setBusy(''); }
  };
  const first = (sum?.teams_total ?? 0) + 1;
  const canIssue = admin.can_issue_credentials;

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-black">Teams & credentials</h1>
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      {!canIssue && <Alert tone="amber">Your account doesn’t have credential-issuance permission. You can print registration slips (PINs masked) only.</Alert>}

      <Card className="space-y-3">
        <h2 className="font-bold">{sum?.teams_total ? 'Extend team capacity' : 'Generate teams'}</h2>
        <p className="text-sm text-slate-600">Creates permanent numbered teams, each with a team PIN and four permanent participant-slot PINs. Numbers continue from the highest existing team and are never reused.</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="How many teams (max 100 per batch)"><input className="input w-40" type="number" min={1} max={100} value={count} onChange={(e) => setCount(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} /></Field>
          <Button disabled={!canIssue || !admin.atLeast('admin')} onClick={() => setConfirm(true)}>
            Generate Team {String(first).padStart(3, '0')}–{String(first + count - 1).padStart(3, '0')}
          </Button>
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-bold">Print slips (A4, two teams per page)</h2>
        <p className="text-sm text-slate-600">Credential slips contain plaintext PINs, recovered only from encrypted packages that are still inside their issuance window. Printing marks those PINs as <em>issued</em>. Each slip has four detachable personal-PIN coupons.</p>
        <div className="flex flex-wrap gap-2">
          {canIssue && <Button busy={busy === 'all'} onClick={() => act('all', async () => {
            const r = await download('/api/admin/slips', { with_pins: true, include_unregistered: true });
            return r.missing ? `Downloaded. ${r.missing} PIN(s) were not recoverable and show “REISSUE”.` : 'All credential slips downloaded.';
          })}>Batch print ALL credential slips</Button>}
          {canIssue && <Button variant="secondary" busy={busy === 'reg'} onClick={() => act('reg', async () => {
            const r = await download('/api/admin/slips', { with_pins: true, include_unregistered: false });
            return r.missing ? `Downloaded. ${r.missing} PIN(s) show “REISSUE”.` : 'Credential slips for registered teams downloaded.';
          })}>Registered teams only</Button>}
          <Button variant="secondary" busy={busy === 'mask'} onClick={() => act('mask', async () => { await download('/api/admin/slips', { with_pins: false, include_unregistered: false }); return 'Registration slips (PINs masked) downloaded.'; })}>Registration slips (no PINs)</Button>
        </div>
        {sum && <p className="text-xs text-slate-500">{sum.credentials_undisclosed} PINs not yet printed · {sum.credentials_compromised} awaiting reissue</p>}
      </Card>

      <Card>
        <h2 className="mb-3 font-bold">Credential packages</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-500"><tr><th className="py-2">Created</th><th>Purpose</th><th>Teams</th><th>PINs</th><th>Status</th><th>Printed</th><th /></tr></thead>
          <tbody className="divide-y">
            {pkgs.map((p) => (
              <tr key={p.id}>
                <td className="py-2">{new Date(p.created_at).toLocaleString()}</td>
                <td>{p.purpose}</td>
                <td className="font-mono">{range(p.team_numbers)}</td>
                <td>{p.credential_count}</td>
                <td>{p.available ? <Badge tone="green">available until {new Date(p.expires_at).toLocaleString()}</Badge> : <Badge>destroyed{p.purged_at ? ` ${new Date(p.purged_at).toLocaleDateString()}` : ''}</Badge>}</td>
                <td>{p.download_count}×</td>
                <td className="text-right">{p.available && canIssue && (
                  <Button variant="ghost" busy={busy === p.id} onClick={() => { if (window.confirm('Destroy this package now? Unprinted PINs will need supervised reissue.')) act(p.id, async () => { await api(`/api/admin/packages/${p.id}/purge`, { body: {} }); return 'Package destroyed.'; }); }}>Destroy now</Button>
                )}</td>
              </tr>
            ))}
            {pkgs.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-slate-500">No packages yet.</td></tr>}
          </tbody>
        </table>
      </Card>

      <Modal open={confirm} title="Generate teams?" onClose={() => setConfirm(false)}>
        <p className="text-sm text-slate-600">This creates Team {String(first).padStart(3, '0')}–{String(first + count - 1).padStart(3, '0')} with {count * 5} permanent PINs. Print the slips before the package expires — after that, PINs can only be replaced through supervised reissue.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirm(false)}>Cancel</Button>
          <Button busy={busy === 'gen'} onClick={() => { setConfirm(false); act('gen', async () => { const r = await api<{ teams: unknown[] }>('/api/admin/provision', { body: { count } }); return `Generated ${r.teams.length} teams with ${r.teams.length * 5} unique PINs.`; }); }}>Generate</Button>
        </div>
      </Modal>
    </div>
  );
}
