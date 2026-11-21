'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/components/api';

interface LiveGoodie { id: string; name: string; stock: number; left: number; image: string | null }

interface Summary {
  event: { name: string; problems_open: boolean; goodies_open: boolean };
  teams_registered: number; slots_occupied: number; assignments: number; reservations: number;
}

export function QrScreen({ arena, title, subtitle, url, svg, canToggle }: { arena: 'problems' | 'goodies'; title: string; subtitle: string; url: string; svg: string; canToggle: boolean }) {
  const key = arena === 'problems' ? 'problems_open' : 'goodies_open';
  const [s, setS] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(() => api<Summary>('/api/admin/summary').then(setS).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [load]);

  // goodies: live counts straight from the public feed (same numbers participants see)
  const [goodies, setGoodies] = useState<LiveGoodie[] | null>(null);
  const busyFeed = useRef(false);
  useEffect(() => {
    if (arena !== 'goodies') return;
    const tick = async () => {
      if (busyFeed.current) return;
      busyFeed.current = true;
      try { const r = await fetch('/api/survey/feed', { cache: 'no-store' }); if (r.ok) setGoodies((await r.json()).goodies); } catch { /* keep last */ } finally { busyFeed.current = false; }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [arena]);
  const open = s?.event[key] ?? false;

  async function toggle() {
    if (!window.confirm(`${open ? 'CLOSE' : 'OPEN'} the ${title}?`)) return;
    setBusy(true); setErr('');
    try { await api('/api/admin/event-flags', { body: { [key]: !open } }); await load(); } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); } finally { setBusy(false); }
  }

  const progress = arena === 'problems'
    ? s && `${s.assignments} of ${s.teams_registered} teams have locked a problem`
    : goodies && `${goodies.reduce((n, g) => n + g.stock - g.left, 0)} goodies chosen · ${goodies.reduce((n, g) => n + g.left, 0)} left`;
  const wide = arena === 'goodies' && !!goodies?.length;

  return (
    <main className="flex min-h-screen flex-col items-center justify-between bg-white px-6 py-8 text-slate-900">
      <header className="text-center">
        <p className="text-sm font-bold uppercase tracking-[0.3em] text-brand-700">{s?.event.name ?? 'Gen AI Designathon'}</p>
        <h1 className="mt-2 text-4xl font-black tracking-tight sm:text-6xl">{title}</h1>
        <p className="mt-2 text-lg text-slate-600 sm:text-2xl">{subtitle}</p>
      </header>

      <div className={`my-6 flex w-full flex-col items-center gap-8 ${wide ? 'lg:flex-row lg:items-start lg:justify-center' : ''}`}>
      <div className="relative shrink-0">
        <div
          className={`rounded-3xl bg-white p-4 shadow-2xl ring-1 ring-slate-200 transition ${wide ? '[&>svg]:h-[min(58vh,80vw)] [&>svg]:w-[min(58vh,80vw)] lg:[&>svg]:h-[min(58vh,38vw)] lg:[&>svg]:w-[min(58vh,38vw)]' : '[&>svg]:h-[min(62vh,80vw)] [&>svg]:w-[min(62vh,80vw)]'} ${open ? '' : 'opacity-25 blur-[2px]'}`}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        {!open && s && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="rounded-2xl bg-slate-900/90 px-6 py-4 text-2xl font-black text-white sm:text-4xl">Opening soon</span>
          </div>
        )}
      </div>
      {wide && (
        <div className="grid w-full max-w-3xl grid-cols-2 gap-3 sm:grid-cols-3">
          {goodies!.map((g) => {
            const out = g.left <= 0;
            return (
              <div key={g.id} className={`overflow-hidden rounded-2xl bg-white shadow ring-1 ring-slate-200 ${out ? 'opacity-50 grayscale' : ''}`}>
                <div className="aspect-[4/3] bg-slate-100">
                  {g.image
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={g.image} alt="" className="h-full w-full object-cover" />
                    : <div className="flex h-full items-center justify-center text-5xl text-slate-300">🎁</div>}
                </div>
                <div className="p-3">
                  <p className="truncate text-lg font-bold">{g.name}</p>
                  <p className={`text-2xl font-black tabular-nums ${out ? 'text-rose-600' : g.left <= Math.max(3, g.stock * 0.1) ? 'text-amber-600' : 'text-emerald-700'}`}>
                    {out ? 'Not available' : `${g.left} left`}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
      </div>

      <footer className="flex w-full max-w-4xl flex-col items-center gap-3 text-center">
        <p className="font-mono text-base text-slate-500 sm:text-xl">{url.replace(/^https?:\/\//, '')}</p>
        {progress && <p className="text-lg font-semibold text-slate-700 sm:text-2xl">{progress}</p>}
        <div className="flex flex-wrap items-center justify-center gap-2 opacity-60 transition hover:opacity-100">
          <span className={`rounded-full px-3 py-1 text-sm font-bold ${open ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>{open ? '● OPEN' : '○ Closed'}</span>
          {canToggle && (
            <button onClick={toggle} disabled={busy || !s} className={`rounded-lg px-4 py-2 text-sm font-semibold text-white ${open ? 'bg-rose-600 hover:bg-rose-500' : 'bg-brand-700 hover:bg-brand-600'} disabled:opacity-50`}>
              {busy ? '…' : `${open ? 'Close' : 'Open'} ${arena === 'goodies' ? 'survey' : 'arena'}`}
            </button>
          )}
          <button onClick={() => document.documentElement.requestFullscreen?.().catch(() => undefined)} className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50">Full screen</button>
          <a href={`/admin/${arena}`} className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50">Back to console</a>
        </div>
        {err && <p className="text-sm text-rose-700">{err}</p>}
      </footer>
    </main>
  );
}
