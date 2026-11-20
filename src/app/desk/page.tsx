'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

interface Person { employee_id: string; name: string; goodie: string; meal: 'veg' | 'nonveg' | null; image: string | null; checked_in_at: string }
interface Done { employee_id: string; name: string; goodie: string; collected_at: string; collected_by: string | null }
interface Queue { queue: Person[]; recent: Done[]; collected: number; total: number; at: string }
interface Lookup { status: string; employee_id: string; name: string | null; goodie?: string; meal?: string | null; collected_at?: string | null }

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
const MEAL: Record<string, string> = { veg: '🟢 Veg', nonveg: '🔴 Non-veg' };

async function call<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) { const e = new Error(j?.error?.message ?? 'Something went wrong') as Error & { status?: number }; e.status = r.status; throw e; }
  return j as T;
}

function SignIn({ event, onDone }: { event: string; onDone: () => void }) {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <form className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-lg ring-1 ring-slate-200" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr('');
        try { await call('/api/desk/unlock', { name, pin }); onDone(); } catch (x) { setErr(x instanceof Error ? x.message : 'Failed'); } finally { setBusy(false); }
      }}>
        <p className="text-xs font-bold uppercase tracking-widest text-brand-700">{event}</p>
        <h1 className="mt-1 text-2xl font-black">Goodie distribution desk</h1>
        <label className="mt-5 block text-xs font-bold uppercase tracking-wide text-slate-500">Your name</label>
        <input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus placeholder="e.g. Priya" />
        <label className="mt-3 block text-xs font-bold uppercase tracking-wide text-slate-500">Desk PIN</label>
        <input className="input mt-1 font-mono tracking-widest" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} inputMode="numeric" type="password" />
        {err && <p className="mt-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-200">{err}</p>}
        <button disabled={busy || name.trim().length < 2 || pin.length < 4} className="mt-5 w-full rounded-xl bg-brand-600 py-3 font-bold text-white disabled:opacity-50">{busy ? 'Signing in…' : 'Start distributing'}</button>
      </form>
    </main>
  );
}

export default function DeskPage() {
  const [me, setMe] = useState<{ signed_in: boolean; name: string | null; event: string } | null>(null);
  const [q, setQ] = useState<Queue | null>(null);
  const [svg, setSvg] = useState('');
  const [url, setUrl] = useState('');
  const [showQr, setShowQr] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [find, setFind] = useState('');
  const [found, setFound] = useState<Lookup | null>(null);
  const inFlight = useRef(false);

  const loadMe = useCallback(() => call<{ signed_in: boolean; name: string | null; event: string }>('/api/desk/unlock').then(setMe).catch(() => setMe({ signed_in: false, name: null, event: 'Gen AI Designathon' })), []);
  useEffect(() => { loadMe(); }, [loadMe]);

  useEffect(() => {
    const u = `${(process.env.NEXT_PUBLIC_APP_URL || window.location.origin).replace(/\/+$/, '')}/collect`;
    setUrl(u);
    QRCode.toString(u, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(setSvg).catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try { setQ(await call<Queue>('/api/desk/queue')); }
    catch (e) { if ((e as { status?: number }).status === 401) loadMe(); }
    finally { inFlight.current = false; }
  }, [loadMe]);
  useEffect(() => {
    if (!me?.signed_in) return;
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 1500);
    return () => clearInterval(t);
  }, [me, load]);

  function say(tone: 'ok' | 'err', text: string) { setToast({ tone, text }); setTimeout(() => setToast(null), 4000); }

  async function mark(emp: string, action: 'collect' | 'undo' | 'skip', label: string) {
    setBusy(emp + action);
    try {
      await call('/api/desk/mark', { employee_id: emp, action });
      say('ok', label);
      if (found?.employee_id === emp) setFound(null);
      await load();
    } catch (e) { say('err', e instanceof Error ? e.message : 'Failed'); await load(); }
    finally { setBusy(null); }
  }

  if (!me) return <p className="p-10 text-center text-slate-400">Loading…</p>;
  if (!me.signed_in) return <SignIn event={me.event} onDone={loadMe} />;

  return (
    <main className="min-h-screen bg-slate-100">
      <header className="flex flex-wrap items-center gap-3 bg-white px-4 py-3 shadow-sm">
        <div className="mr-auto">
          <p className="text-xs font-bold uppercase tracking-widest text-brand-700">{me.event}</p>
          <h1 className="text-lg font-black leading-tight">Goodie distribution</h1>
        </div>
        {q && <p className="rounded-full bg-emerald-50 px-3 py-1 text-sm font-bold text-emerald-800 ring-1 ring-emerald-200">{q.collected} / {q.total} collected</p>}
        <span className="text-sm text-slate-500">Desk: <strong className="text-slate-800">{me.name}</strong></span>
        <button className="text-xs font-semibold text-slate-500 underline" onClick={async () => { await call('/api/desk/logout', {}); loadMe(); }}>Sign out</button>
      </header>

      {toast && <div className={`fixed left-1/2 top-4 z-50 -translate-x-1/2 rounded-xl px-4 py-3 text-sm font-semibold shadow-lg ${toast.tone === 'ok' ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'}`}>{toast.text}</div>}

      <div className="mx-auto grid max-w-6xl gap-4 p-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
        {/* the single shared QR */}
        <section className="h-fit rounded-3xl bg-white p-5 text-center shadow-sm ring-1 ring-slate-200 lg:sticky lg:top-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Scan to collect</h2>
            <button className="text-xs font-semibold text-brand-700 lg:hidden" onClick={() => setShowQr((v) => !v)}>{showQr ? 'Hide QR' : 'Show QR'}</button>
          </div>
          {showQr && <>
            <div className="mx-auto mt-3 w-full max-w-[18rem] [&>svg]:h-auto [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
            <p className="mt-2 text-sm text-slate-600">Scan → enter employee ID → show your phone</p>
            <p className="mt-1 break-all font-mono text-xs text-slate-400">{url.replace(/^https?:\/\//, '')}</p>
            <button className="mt-3 text-xs font-semibold text-slate-500 underline" onClick={() => document.documentElement.requestFullscreen?.().catch(() => undefined)}>Full screen</button>
          </>}
          {/* for people without a phone */}
          <form className="mt-5 border-t border-slate-100 pt-4 text-left" onSubmit={async (e) => {
            e.preventDefault(); setFound(null);
            try { const r = await call<{ person: Lookup }>(`/api/desk/queue?emp=${encodeURIComponent(find.trim())}`); setFound(r.person); } catch (x) { say('err', x instanceof Error ? x.message : 'Failed'); }
          }}>
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500">No phone? Look up by employee ID</label>
            <div className="mt-1 flex gap-2">
              <input className="input" value={find} onChange={(e) => setFind(e.target.value.toUpperCase().replace(/\s/g, ''))} placeholder="e.g. 1000***" maxLength={40} />
              <button disabled={find.trim().length < 2} className="rounded-xl bg-slate-900 px-4 text-sm font-bold text-white disabled:opacity-40">Find</button>
            </div>
            {found && (
              <div className="mt-3 rounded-2xl bg-slate-50 p-3 ring-1 ring-slate-200">
                <p className="font-bold">{found.name ?? found.employee_id} <span className="font-mono text-xs text-slate-500">{found.employee_id}</span></p>
                {found.status === 'ready' && <>
                  <p className="text-lg font-black text-brand-700">{found.goodie} {found.meal && <span className="text-sm font-semibold text-slate-600">· {MEAL[found.meal]}</span>}</p>
                  <button disabled={busy === found.employee_id + 'collect'} onClick={() => mark(found.employee_id, 'collect', `${found.name} — ${found.goodie} collected`)}
                    className="mt-2 w-full rounded-xl bg-emerald-600 py-2.5 font-bold text-white disabled:opacity-50">✓ Collected</button>
                </>}
                {found.status === 'collected' && <p className="text-sm text-emerald-700">Already collected {found.goodie}{found.collected_at ? ` at ${time(found.collected_at)}` : ''}</p>}
                {found.status === 'declined' && <p className="text-sm text-slate-600">Said they are not attending — no goodie booked.</p>}
                {found.status === 'none' && <p className="text-sm text-slate-600">No goodie booked for this ID.</p>}
              </div>
            )}
          </form>
        </section>

        {/* the shared live queue */}
        <section className="space-y-4">
          <div>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-500">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" /> Waiting at the desk ({q?.queue.length ?? 0})
            </h2>
            {q && q.queue.length === 0 && <p className="rounded-3xl bg-white p-10 text-center text-slate-400 ring-1 ring-slate-200">Nobody waiting. People appear here as soon as they scan and enter their ID.</p>}
            <div className="grid gap-3 sm:grid-cols-2">
              {q?.queue.map((p) => (
                <div key={p.employee_id} className="flex gap-3 rounded-3xl bg-white p-4 shadow-sm ring-2 ring-amber-300">
                  {p.image
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={p.image} alt="" className="h-20 w-20 shrink-0 rounded-2xl object-cover" />
                    : <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-4xl">🎁</div>}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-lg font-black leading-tight">{p.name}</p>
                    <p className="font-mono text-xs text-slate-500">{p.employee_id} · since {time(p.checked_in_at)}</p>
                    <p className="mt-1 text-xl font-black text-brand-700">{p.goodie}</p>
                    {p.meal && <p className="text-xs font-semibold text-slate-600">{MEAL[p.meal]}</p>}
                    <div className="mt-2 flex gap-2">
                      <button disabled={!!busy} onClick={() => mark(p.employee_id, 'collect', `${p.name} — ${p.goodie} collected`)}
                        className="flex-1 rounded-xl bg-emerald-600 py-2.5 font-bold text-white hover:bg-emerald-500 disabled:opacity-50">
                        {busy === p.employee_id + 'collect' ? '…' : '✓ Collected'}
                      </button>
                      <button disabled={!!busy} onClick={() => mark(p.employee_id, 'skip', `${p.name} removed from the queue`)} title="Remove from queue (not collected)"
                        className="rounded-xl px-3 text-sm font-semibold text-slate-500 ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-50">Skip</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {!!q?.recent.length && (
            <div className="rounded-3xl bg-white p-4 ring-1 ring-slate-200">
              <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">Just collected</h2>
              <ul className="divide-y divide-slate-100 text-sm">
                {q.recent.map((d) => (
                  <li key={d.employee_id} className="flex items-center gap-3 py-2">
                    <span className="text-emerald-600">✓</span>
                    <span className="min-w-0 flex-1 truncate"><strong>{d.name}</strong> · {d.goodie}</span>
                    <span className="text-xs text-slate-400">{time(d.collected_at)}{d.collected_by ? ` · ${d.collected_by}` : ''}</span>
                    {Date.now() - Date.parse(d.collected_at) < 15 * 60 * 1000 && (
                      <button disabled={!!busy} onClick={() => mark(d.employee_id, 'undo', `Undone — ${d.name} is back in the queue`)} className="text-xs font-semibold text-rose-700 hover:underline">Undo</button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
