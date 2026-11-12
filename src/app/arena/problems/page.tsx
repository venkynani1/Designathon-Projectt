'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/components/api';
import { Alert, Badge, Button, Card, Field, Modal, teamLabel } from '@/components/ui';

interface Problem { id: string; code: string; title: string; summary: string | null; capacity: number; remaining: number; document_url: string | null }
interface State {
  team: { team_number: number; name: string | null };
  members: { slot: string; name: string }[];
  problems_open: boolean;
  assignment: { problem_id: string; code: string; title: string; locked_at: string } | null;
  problems: Problem[];
}

function Login({ onDone }: { onDone: () => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<{ team_number: number; name: string }[]>([]);
  const [team, setTeam] = useState<number | null>(null);
  const [teamName, setTeamName] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (team != null || q.trim().length < 1) return setHits([]);
    const h = setTimeout(() => api<{ teams: typeof hits }>(`/api/arena/teams?q=${encodeURIComponent(q)}`).then((r) => setHits(r.teams)).catch(() => setHits([])), 200);
    return () => clearTimeout(h);
  }, [q, team]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = team ?? Number(q.replace(/\D/g, ''));
    if (!n) return setErr('Choose your team number or name first.');
    setBusy(true);
    setErr('');
    try {
      await api('/api/arena/problems/login', { body: { team_number: n, pin } });
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Network error — try again.');
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mx-auto max-w-md">
      <h1 className="text-2xl font-black">Problem Statement Arena</h1>
      <p className="mt-1 text-sm text-slate-600">Find your team, then enter the Team PIN from your slip.</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        {team == null ? (
          <Field label="Team number or team name">
            <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. 40 or Design Ninjas" autoComplete="off" />
            {hits.length > 0 && (
              <ul className="mt-2 divide-y overflow-hidden rounded-lg ring-1 ring-slate-200">
                {hits.map((h) => (
                  <li key={h.team_number}>
                    <button type="button" className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-brand-50" onClick={() => { setTeam(h.team_number); setTeamName(h.name); }}>
                      <span className="font-semibold">{teamLabel(h.team_number)}</span>
                      <span className="text-slate-600">{h.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Field>
        ) : (
          <div className="flex items-center justify-between rounded-lg bg-brand-50 px-3 py-2">
            <div><div className="text-xs font-semibold text-brand-700">{teamLabel(team)}</div><div className="font-bold">{teamName}</div></div>
            <Button type="button" variant="ghost" onClick={() => { setTeam(null); setPin(''); }}>Change</Button>
          </div>
        )}
        <Field label="Team PIN">
          <input className="pin-input" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="••••••" aria-label="Team PIN" />
        </Field>
        {err && <Alert>{err}</Alert>}
        <Button className="w-full" busy={busy} disabled={pin.length !== 6}>Verify team</Button>
      </form>
    </Card>
  );
}

export default function ProblemArena() {
  const [state, setState] = useState<State | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [pick, setPick] = useState<Problem | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api<State>('/api/arena/problems/state'));
      setNeedLogin(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setNeedLogin(true); setState(null); }
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 8000); // keeps every teammate's device in sync
    return () => clearInterval(t);
  }, [load]);

  async function lock() {
    if (!pick) return;
    setBusy(true);
    setErr('');
    try {
      await api('/api/arena/problems/lock', { body: { problem_id: pick.id } });
      setPick(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Network error — your choice was not saved. Try again.');
    } finally {
      setBusy(false);
      load();
    }
  }

  async function logout() {
    await api('/api/arena/problems/logout', { body: {} }).catch(() => undefined);
    setNeedLogin(true);
    setState(null);
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      {needLogin && <Login onDone={load} />}
      {!needLogin && !state && <p className="text-center text-slate-500">Loading…</p>}
      {state && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-brand-700">{teamLabel(state.team.team_number)}</p>
              <h1 className="text-3xl font-black">{state.team.name}</h1>
              <p className="mt-1 text-sm text-slate-600">{state.members.map((m) => `${m.slot} ${m.name}`).join(' · ')}</p>
            </div>
            <Button variant="secondary" onClick={logout}>Sign out</Button>
          </div>

          {state.assignment ? (
            <Alert tone="green">
              <strong>Locked:</strong> {state.assignment.code} — {state.assignment.title}. This choice is final and shared by your whole team.
            </Alert>
          ) : state.problems_open ? (
            <Alert tone="blue">Discuss with your team, then lock ONE problem statement. The first teammate to lock decides for everyone.</Alert>
          ) : (
            <Alert tone="amber">Problem statement selection hasn&apos;t opened yet. You can browse; this page refreshes automatically.</Alert>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            {state.problems.map((p) => {
              const mine = state.assignment?.problem_id === p.id;
              const full = p.remaining <= 0;
              return (
                <Card key={p.id} className={mine ? 'ring-2 ring-emerald-500' : ''}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-bold text-brand-700">{p.code}</p>
                      <h2 className="text-lg font-bold">{p.title}</h2>
                    </div>
                    {mine ? <Badge tone="green">Your team</Badge> : full ? <Badge tone="red">Full</Badge> : <Badge tone="blue">{p.remaining}/{p.capacity} left</Badge>}
                  </div>
                  {p.summary && <p className="mt-2 text-sm text-slate-600">{p.summary}</p>}
                  <div className="mt-3 h-1.5 overflow-hidden rounded bg-slate-100">
                    <div className="h-full bg-brand-500" style={{ width: `${((p.capacity - p.remaining) / p.capacity) * 100}%` }} />
                  </div>
                  <div className="mt-4 flex gap-2">
                    {p.document_url && <a className="inline-flex items-center rounded-lg px-3 py-2 text-sm font-semibold text-brand-700 ring-1 ring-brand-100 hover:bg-brand-50" href={p.document_url} target="_blank" rel="noopener noreferrer">Preview brief</a>}
                    {!state.assignment && (
                      <Button disabled={!state.problems_open || full} onClick={() => { setErr(''); setPick(p); }}>Lock this problem</Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}
      <Modal open={!!pick} title="Lock this problem statement?" onClose={() => setPick(null)}>
        <p className="text-sm text-slate-700"><strong>{pick?.code} — {pick?.title}</strong></p>
        <p className="mt-2 text-sm text-slate-600">This is permanent for your entire team and cannot be changed.</p>
        {err && <div className="mt-3"><Alert>{err}</Alert></div>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setPick(null)}>Cancel</Button>
          <Button busy={busy} onClick={lock}>Yes, lock it</Button>
        </div>
      </Modal>
    </main>
  );
}
