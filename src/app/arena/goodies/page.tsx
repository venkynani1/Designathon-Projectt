'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/components/api';
import { Alert, Badge, Button, Card, Field, Modal, teamLabel } from '@/components/ui';

interface Goodie { id: string; name: string; description: string | null; remaining: number }
interface State {
  participant: { name: string; slot: string; team_number: number; team_name: string; goodies_eligible: boolean };
  goodies_open: boolean;
  reservation: { goodie_id: string; name: string; status: string; reserved_at: string } | null;
  goodies: Goodie[];
}

function Login({ onDone }: { onDone: () => void }) {
  const [emp, setEmp] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api('/api/arena/goodies/login', { body: { employee_id: emp, pin } });
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
      <h1 className="text-2xl font-black">Goodies Arena</h1>
      <p className="mt-1 text-sm text-slate-600">Sign in with your employee ID and the personal PIN from your coupon.</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <Field label="Employee ID">
          <input className="input" value={emp} onChange={(e) => setEmp(e.target.value)} autoFocus autoComplete="username" autoCapitalize="characters" />
        </Field>
        <Field label="Personal PIN">
          <input className="pin-input" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="current-password" type="password" aria-label="Personal PIN" />
        </Field>
        {err && <Alert>{err}</Alert>}
        <Button className="w-full" busy={busy} disabled={!emp || pin.length !== 6}>Sign in</Button>
      </form>
    </Card>
  );
}

export default function GoodiesArena() {
  const [state, setState] = useState<State | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [pick, setPick] = useState<Goodie | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api<State>('/api/arena/goodies/state'));
      setNeedLogin(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setNeedLogin(true); setState(null); }
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 10000);
    return () => clearInterval(t);
  }, [load]);

  async function reserve() {
    if (!pick) return;
    setBusy(true);
    setErr('');
    try {
      setState(await api<State>('/api/arena/goodies/reserve', { body: { goodie_id: pick.id } }));
      setPick(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Network error — try again.');
      load();
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await api('/api/arena/goodies/logout', { body: {} }).catch(() => undefined);
    setNeedLogin(true);
    setState(null);
  }

  const p = state?.participant;
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      {needLogin && <Login onDone={load} />}
      {!needLogin && !state && <p className="text-center text-slate-500">Loading…</p>}
      {state && p && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-brand-700">{teamLabel(p.team_number)} · {p.team_name} · {p.slot}</p>
              <h1 className="text-3xl font-black">Hi, {p.name}</h1>
            </div>
            <Button variant="secondary" onClick={logout}>Sign out</Button>
          </div>
          {state.reservation ? (
            <Alert tone="green"><strong>Reserved:</strong> {state.reservation.name} ({state.reservation.status}). Show this screen at the goodies counter.</Alert>
          ) : !p.goodies_eligible ? (
            <Alert tone="amber">You&apos;re not eligible for goodies. Please check with the registration desk.</Alert>
          ) : !state.goodies_open ? (
            <Alert tone="amber">Goodies reservation hasn&apos;t opened yet. This page refreshes automatically.</Alert>
          ) : (
            <Alert tone="blue">Pick ONE goodie. Your reservation is permanent and personal.</Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {state.goodies.map((g) => {
              const mine = state.reservation?.goodie_id === g.id;
              const out = g.remaining <= 0;
              return (
                <Card key={g.id} className={mine ? 'ring-2 ring-emerald-500' : ''}>
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-bold">{g.name}</h2>
                    {mine ? <Badge tone="green">Yours</Badge> : out ? <Badge tone="red">Gone</Badge> : <Badge tone="blue">{g.remaining} left</Badge>}
                  </div>
                  {g.description && <p className="mt-2 text-sm text-slate-600">{g.description}</p>}
                  {!state.reservation && (
                    <Button className="mt-4 w-full" disabled={!state.goodies_open || out || !p.goodies_eligible} onClick={() => { setErr(''); setPick(g); }}>Reserve</Button>
                  )}
                </Card>
              );
            })}
          </div>
        </div>
      )}
      <Modal open={!!pick} title={`Reserve ${pick?.name ?? ''}?`} onClose={() => setPick(null)}>
        <p className="text-sm text-slate-600">You can reserve only one goodie for the whole event. This can&apos;t be changed.</p>
        {err && <div className="mt-3"><Alert>{err}</Alert></div>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setPick(null)}>Cancel</Button>
          <Button busy={busy} onClick={reserve}>Confirm reservation</Button>
        </div>
      </Modal>
    </main>
  );
}
