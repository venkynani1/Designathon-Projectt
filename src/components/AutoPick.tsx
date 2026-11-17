'use client';
import { useEffect, useRef, useState } from 'react';

interface Info { name: string; employee_id: string; open: boolean; event: string; goodie: string | null }
type State = { kind: 'loading' } | { kind: 'waiting'; info: Info } | { kind: 'done'; name: string; goodie: string; emp: string }
  | { kind: 'error'; message: string; info?: Info };

/** Personal link: claims the goodie the moment the page opens (or the moment choosing opens). */
export function AutoPick({ token }: { token: string }) {
  const [s, setS] = useState<State>({ kind: 'loading' });
  const busy = useRef(false);

  useEffect(() => {
    let stop = false;
    const claim = async (info: Info) => {
      const r = await fetch(`/api/survey/auto/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const j = await r.json().catch(() => null);
      if (r.ok) {
        try { localStorage.setItem('dx-goodie-choice', JSON.stringify({ goodie: j.goodie, name: j.name, employee_id: j.employee_id })); } catch { /* */ }
        setS({ kind: 'done', name: j.name, goodie: j.goodie, emp: j.employee_id });
        return true;
      }
      if (j?.error?.code === 'ARENA_CLOSED') { setS({ kind: 'waiting', info }); return false; }
      setS({ kind: 'error', message: j?.error?.message ?? 'Something went wrong — try again', info });
      return true;
    };
    const tick = async () => {
      if (busy.current || stop) return;
      busy.current = true;
      try {
        const r = await fetch(`/api/survey/auto/${token}`, { cache: 'no-store' });
        const info = await r.json().catch(() => null);
        if (!r.ok) { setS({ kind: 'error', message: info?.error?.message ?? 'This link is not valid' }); stop = true; return; }
        if (info.goodie) { setS({ kind: 'done', name: info.name, goodie: info.goodie, emp: info.employee_id }); stop = true; return; }
        if (!info.open) { setS({ kind: 'waiting', info }); return; }
        if (await claim(info)) stop = true;
      } catch { /* offline: retry */ } finally { busy.current = false; }
    };
    tick();
    const t = setInterval(() => { if (!stop) tick(); }, 1000);
    return () => { stop = true; clearInterval(t); };
  }, [token]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-700 via-brand-600 to-indigo-500 p-4">
      <div className="w-full max-w-md rounded-3xl bg-white p-8 text-center shadow-2xl">
        {s.kind === 'loading' && <p className="py-8 text-slate-500">Getting your goodie…</p>}
        {s.kind === 'waiting' && (
          <>
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 text-3xl">⏳</div>
            <h1 className="mt-4 text-2xl font-black">Hi {s.info.name.split(' ')[0]}!</h1>
            <p className="mt-2 text-slate-600">Your goodie will be assigned automatically as soon as choosing opens — you don’t need to do anything. This page updates by itself.</p>
            <p className="mt-4 inline-flex items-center gap-2 text-sm text-slate-400"><span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" /> Waiting…</p>
          </>
        )}
        {s.kind === 'done' && (
          <>
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-3xl text-emerald-700">✓</div>
            <h1 className="mt-4 text-2xl font-black">You’re all set, {s.name.split(' ')[0]}!</h1>
            <p className="mt-2 text-slate-600">Your goodie: <strong className="text-slate-900">{s.goodie}</strong></p>
            <p className="mt-1 text-sm text-slate-500">Employee ID {s.emp}</p>
            <a href="/goodies" className="mt-6 inline-block text-sm font-semibold text-brand-700 hover:underline">See the live goodies →</a>
          </>
        )}
        {s.kind === 'error' && (
          <>
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-rose-100 text-3xl text-rose-700">!</div>
            <p className="mt-4 font-semibold text-slate-900">{s.message}</p>
            <a href="/goodies" className="mt-6 inline-block text-sm font-semibold text-brand-700 hover:underline">Open the goodies page →</a>
          </>
        )}
      </div>
    </main>
  );
}
