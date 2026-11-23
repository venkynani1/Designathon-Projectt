'use client';
import { useEffect, useRef, useState } from 'react';

interface View {
  status: 'ready' | 'collected' | 'declined' | 'none';
  employee_id: string; name: string | null; goodie?: string; meal?: 'veg' | 'nonveg' | null; came_at?: string | null;
  image?: string | null; collected_at?: string | null;
}
const KEY = 'dx-collect-emp';
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

/** Participant at the distribution desk: scan the desk QR, enter employee ID, show this screen. */
export default function CollectPage() {
  const [emp, setEmp] = useState('');
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const polling = useRef(false);

  async function checkin(id: string) {
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/collect/checkin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ employee_id: id }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message ?? 'Something went wrong');
      setView(j);
      try { if (j.status === 'ready' || j.status === 'collected') localStorage.setItem(KEY, j.employee_id); } catch { /* */ }
    } catch (e) { setErr(e instanceof Error ? e.message : 'Network problem — try again'); } finally { setBusy(false); }
  }

  // reopened the page: resume where they were
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { try { const saved = localStorage.getItem(KEY); if (saved) { setEmp(saved); checkin(saved); } } catch { /* */ } }, []);

  // waiting at the desk: flip to "Collected" as soon as a distributor taps it
  useEffect(() => {
    if (view?.status !== 'ready') return;
    const t = setInterval(async () => {
      if (polling.current || document.visibilityState !== 'visible') return;
      polling.current = true;
      try {
        const r = await fetch(`/api/collect/status?emp=${encodeURIComponent(view.employee_id)}`, { cache: 'no-store' });
        if (r.ok) setView(await r.json());
      } catch { /* retry */ } finally { polling.current = false; }
    }, 3000);
    return () => clearInterval(t);
  }, [view]);

  async function chooseMeal(meal: 'veg' | 'nonveg') {
    if (!view) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/collect/meal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ employee_id: view.employee_id, meal }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message ?? 'Something went wrong');
      setView(j);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Network problem — try again'); } finally { setBusy(false); }
  }

  const reset = () => { try { localStorage.removeItem(KEY); } catch { /* */ } setView(null); setEmp(''); setErr(''); };
  const first = view?.name?.split(' ')[0] ?? '';

  return (
    <main className="min-h-screen bg-slate-50">
      <header className="bg-gradient-to-br from-brand-700 via-brand-600 to-indigo-500 px-4 pb-14 pt-8 text-white">
        <div className="mx-auto max-w-md">
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-white/70">Gen AI Designathon</p>
          <h1 className="mt-1 text-3xl font-black tracking-tight">Collect your goodie 🎁</h1>
        </div>
      </header>
      <div className="mx-auto -mt-8 max-w-md px-4 pb-10">
        {!view && (
          <form onSubmit={(e) => { e.preventDefault(); if (emp.trim().length >= 2) checkin(emp.trim()); }} className="rounded-3xl bg-white p-6 shadow-lg ring-1 ring-slate-200">
            <label htmlFor="emp" className="block text-xs font-bold uppercase tracking-wide text-slate-500">Your employee ID</label>
            <input id="emp" className="input mt-1 h-14 text-xl font-semibold tracking-wide" value={emp} autoFocus
              onChange={(e) => setEmp(e.target.value.toUpperCase().replace(/\s/g, ''))} maxLength={40} autoComplete="off" placeholder="e.g. 1000***" />
            {err && <p className="mt-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-200">{err}</p>}
            <button disabled={busy || emp.trim().length < 2} className="mt-4 w-full rounded-xl bg-brand-600 py-3.5 text-lg font-bold text-white disabled:opacity-50">
              {busy ? 'Checking…' : 'Show my goodie'}
            </button>
          </form>
        )}

        {view?.status === 'ready' && !view.meal && (
          <section className="rounded-3xl bg-white p-6 text-center shadow-lg ring-1 ring-slate-200">
            <p className="text-2xl font-black">Hi {first}!</p>
            <p className="mt-1 text-slate-600">Your goodie: <strong className="text-slate-900">{view.goodie}</strong></p>
            <p className="mt-5 text-sm font-bold uppercase tracking-wide text-slate-500">Choose your meal</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <button disabled={busy} onClick={() => chooseMeal('veg')} className="rounded-2xl bg-emerald-50 py-5 text-lg font-bold text-emerald-800 ring-2 ring-emerald-500 disabled:opacity-50">🟢 Veg</button>
              <button disabled={busy} onClick={() => chooseMeal('nonveg')} className="rounded-2xl bg-rose-50 py-5 text-lg font-bold text-rose-800 ring-2 ring-rose-500 disabled:opacity-50">🔴 Non-veg</button>
            </div>
            {err && <p className="mt-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-200">{err}</p>}
          </section>
        )}

        {view?.status === 'ready' && !!view.meal && (
          <section className="overflow-hidden rounded-3xl bg-white text-center shadow-lg ring-4 ring-amber-400">
            <div className="bg-amber-400 px-4 py-2 text-sm font-black uppercase tracking-widest text-amber-950">Show this at the desk</div>
            <div className="p-6">
              <p className="text-2xl font-black">Hi {first}!</p>
              <p className="mt-1 text-slate-600">Please collect your goodie</p>
              {view.image
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={view.image} alt="" className="mx-auto mt-4 h-40 w-40 rounded-2xl object-cover ring-1 ring-slate-200" />
                : <div className="mx-auto mt-4 flex h-28 w-28 items-center justify-center rounded-2xl bg-slate-100 text-6xl">🎁</div>}
              <p className="mt-4 text-3xl font-black text-brand-700">{view.goodie}</p>
              {view.meal && <p className="mt-2 inline-block rounded-full bg-slate-100 px-3 py-1 text-sm font-semibold">{view.meal === 'veg' ? '🟢 Veg' : '🔴 Non-veg'}</p>}
              <p className="mt-3 font-mono text-sm text-slate-500">{view.name} · {view.employee_id}</p>
              <p className="mt-4 inline-flex items-center gap-2 text-xs text-slate-400"><span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" /> Waiting for the desk to hand it over…</p>
            </div>
          </section>
        )}

        {view?.status === 'collected' && (
          <section className="rounded-3xl bg-white p-8 text-center shadow-lg ring-4 ring-emerald-500">
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-emerald-100 text-4xl text-emerald-700">✓</div>
            <p className="mt-4 text-2xl font-black">Collected!</p>
            <p className="mt-1 text-slate-600"><strong>{view.goodie}</strong> · {view.name}</p>
            {view.collected_at && <p className="mt-1 text-sm text-slate-500">at {time(view.collected_at)}</p>}
            <p className="mt-4 text-sm text-slate-500">Enjoy the Designathon! 🎉</p>
          </section>
        )}

        {(view?.status === 'declined' || view?.status === 'none') && (
          <section className="rounded-3xl bg-white p-8 text-center shadow-lg ring-1 ring-slate-200">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-slate-100 text-3xl">ℹ️</div>
            <p className="mt-4 text-xl font-black">{view.name ? `Hi ${first}` : view.employee_id}</p>
            <p className="mt-2 text-slate-600">{view.status === 'declined' ? 'You told us you couldn’t attend, so no goodie was booked. We’ve noted that you’re here.' : 'No goodie is booked for this employee ID.'}</p>
            <p className="mt-1 text-sm text-slate-500">Please speak to the organizers at the desk.</p>
          </section>
        )}

        {view && <button onClick={reset} className="mx-auto mt-6 block text-xs text-slate-400 underline">Not you? Enter a different employee ID</button>}
      </div>
    </main>
  );
}
