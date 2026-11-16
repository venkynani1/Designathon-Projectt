'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/components/api';
import { Alert, Button, Field, Modal } from '@/components/ui';

interface Goodie { id: string; name: string; description: string | null; stock: number; left: number; image: string | null }
interface Feed { event: string; open: boolean; goodies: Goodie[]; at: string }
interface Done { goodie: string; name: string; employee_id: string }

const POLL_MS = 4000;
const DONE_KEY = 'dx-goodie-choice';

function readDone(): Done | null {
  try { return JSON.parse(localStorage.getItem(DONE_KEY) ?? 'null'); } catch { return null; }
}

export function GoodiesSurvey() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [offline, setOffline] = useState(false);
  const [emp, setEmp] = useState('');
  const [name, setName] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [done, setDone] = useState<Done | null>(null);
  const [flash, setFlash] = useState<Record<string, number>>({});
  const prev = useRef<Record<string, number>>({});

  const apply = useCallback((f: Feed) => {
    // briefly highlight counts that changed, so people see it's live
    const changed: Record<string, number> = {};
    for (const g of f.goodies) if (prev.current[g.id] !== undefined && prev.current[g.id] !== g.left) changed[g.id] = Date.now();
    prev.current = Object.fromEntries(f.goodies.map((g) => [g.id, g.left]));
    if (Object.keys(changed).length) setFlash((x) => ({ ...x, ...changed }));
    setFeed(f);
    setOffline(false);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/survey/feed', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      apply(await res.json());
    } catch { setOffline(true); }
  }, [apply]);

  useEffect(() => {
    setDone(readDone());
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
    const vis = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [load]);

  // the goodie someone is looking at just ran out → let them know and clear it
  const picked = feed?.goodies.find((g) => g.id === pick) ?? null;
  useEffect(() => {
    if (pick && feed && (!picked || picked.left <= 0)) {
      setNote(`${picked?.name ?? 'That goodie'} just ran out — please pick another.`);
      setPick(null);
      setConfirm(false);
    }
  }, [feed, pick, picked]);

  async function submit() {
    if (!picked) return;
    setBusy(true); setErr('');
    try {
      const r = await api<Done & { feed: Feed }>('/api/survey/submit', { body: { employee_id: emp, name, goodie_id: picked.id } });
      apply(r.feed);
      const d = { goodie: r.goodie, name: r.name, employee_id: r.employee_id };
      try { localStorage.setItem(DONE_KEY, JSON.stringify(d)); } catch { /* private mode */ }
      setDone(d);
      setConfirm(false);
    } catch (e) {
      setConfirm(false);
      if (e instanceof ApiError && e.code === 'OUT_OF_STOCK') { setPick(null); load(); }
      setErr(e instanceof ApiError ? e.message : 'Network problem — please try again.');
    } finally { setBusy(false); }
  }

  const ready = emp.trim().length >= 2 && name.trim().length >= 2 && !!picked;
  const totalLeft = feed?.goodies.reduce((s, g) => s + g.left, 0) ?? 0;

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 pb-32 pt-6">
      <header className="mb-5">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-600">{feed?.event ?? 'Designathon X'}</p>
        <h1 className="text-3xl font-black tracking-tight">Choose your goodie</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${offline ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>
            <span className={`h-2 w-2 rounded-full ${offline ? 'bg-amber-500' : 'animate-pulse bg-emerald-500'}`} />
            {offline ? 'Reconnecting…' : 'Live counts'}
          </span>
          {feed && <span>{totalLeft} goodies left across {feed.goodies.length} options</span>}
        </div>
      </header>

      {done ? (
        <div className="rounded-3xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-200">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-3xl text-emerald-700">✓</div>
          <h2 className="mt-4 text-2xl font-black">You’re all set, {done.name.split(' ')[0]}!</h2>
          <p className="mt-2 text-slate-600">Your goodie: <strong className="text-slate-900">{done.goodie}</strong></p>
          <p className="mt-1 text-sm text-slate-500">Employee ID {done.employee_id}. Collect it at the event.</p>
          <button className="mt-6 text-xs text-slate-400 underline" onClick={() => { try { localStorage.removeItem(DONE_KEY); } catch { /* */ } setDone(null); }}>
            Submitting for someone else on this phone?
          </button>
        </div>
      ) : (
        <>
          {feed && !feed.open && <Alert tone="amber">The goodies survey is closed right now. You can see what’s available — come back when it opens.</Alert>}

          <section className="mt-4 grid gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200 sm:grid-cols-2">
            <Field label="Employee ID">
              <input className="input" value={emp} onChange={(e) => setEmp(e.target.value.toUpperCase().replace(/\s/g, ''))} maxLength={40}
                     autoCapitalize="characters" autoComplete="off" placeholder="e.g. EMP10234" />
            </Field>
            <Field label="Full name">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoComplete="name" placeholder="Your name" />
            </Field>
          </section>

          <h2 className="mb-2 mt-6 text-sm font-bold uppercase tracking-wide text-slate-500">Tap one goodie</h2>
          {note && <div className="mb-3"><Alert tone="amber">{note}</Alert></div>}
          {err && <div className="mb-3"><Alert>{err}</Alert></div>}
          {!feed && !offline && <p className="py-12 text-center text-slate-400">Loading goodies…</p>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {feed?.goodies.map((g) => {
              const out = g.left <= 0;
              const sel = pick === g.id;
              const changed = flash[g.id] && Date.now() - flash[g.id] < 2500;
              return (
                <button key={g.id} type="button" disabled={out || !feed.open}
                  onClick={() => { setPick(g.id); setNote(''); setErr(''); }}
                  aria-pressed={sel}
                  className={`relative overflow-hidden rounded-2xl bg-white text-left shadow-sm ring-2 transition ${sel ? 'ring-brand-600' : 'ring-transparent'} ${out ? 'opacity-50 grayscale' : 'hover:shadow-md'} disabled:cursor-not-allowed`}>
                  <div className="aspect-square w-full bg-slate-100">
                    {g.image
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={g.image} alt={g.name} className="h-full w-full object-cover" loading="lazy" />
                      : <div className="flex h-full items-center justify-center text-4xl text-slate-300">🎁</div>}
                  </div>
                  {sel && <span className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-brand-600 text-sm font-bold text-white">✓</span>}
                  <div className="p-3">
                    <p className="font-bold leading-tight">{g.name}</p>
                    {g.description && <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{g.description}</p>}
                    <p className={`mt-2 text-sm font-bold transition-colors ${out ? 'text-rose-600' : g.left <= Math.max(3, g.stock * 0.1) ? 'text-amber-600' : 'text-emerald-700'} ${changed ? 'rounded bg-yellow-100 px-1' : ''}`}>
                      {out ? 'Not available' : `${g.left} available`}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
          {feed && feed.goodies.length === 0 && <p className="py-12 text-center text-slate-500">No goodies have been added yet.</p>}

          <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/95 p-3 backdrop-blur">
            <div className="mx-auto flex max-w-3xl items-center gap-3">
              <p className="min-w-0 flex-1 truncate text-sm text-slate-600">
                {picked ? <>Selected: <strong className="text-slate-900">{picked.name}</strong></> : 'Pick a goodie above'}
              </p>
              <Button disabled={!ready || !feed?.open} onClick={() => { setErr(''); setConfirm(true); }}>Submit</Button>
            </div>
          </div>
        </>
      )}

      <Modal open={confirm && !!picked} title="Confirm your choice" onClose={() => setConfirm(false)}>
        {picked && (
          <div className="space-y-3">
            <p><strong>{name.trim()}</strong> ({emp}) is choosing <strong>{picked.name}</strong>.</p>
            <p className="text-sm text-slate-500">You can choose only once and it can’t be changed afterwards.</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirm(false)}>Back</Button>
              <Button busy={busy} onClick={submit}>Yes, submit</Button>
            </div>
          </div>
        )}
      </Modal>
    </main>
  );
}
