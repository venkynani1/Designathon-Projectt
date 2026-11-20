'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/components/api';
import { Button, Modal } from '@/components/ui';

interface Goodie { id: string; name: string; description: string | null; stock: number; left: number; image: string | null }
export interface Feed { event: string; open: boolean; list_required?: boolean; goodies: Goodie[]; chosen_total?: number; at: string }
type Meal = 'veg' | 'nonveg';
const MEAL_LABEL: Record<Meal, string> = { veg: 'Veg', nonveg: 'Non-veg' };
interface Done { goodie: string | null; name: string; employee_id: string; meal?: Meal | null; attending?: boolean | null }
interface Lookup { employee_id: string; found: boolean; name: string | null; list_required: boolean; chosen: string | null; declined?: boolean }

const POLL_MS = 1500;
const DONE_KEY = 'dx-goodie-choice';

export function GoodiesSurvey({ initial = null }: { initial?: Feed | null }) {
  const [feed, setFeed] = useState<Feed | null>(initial);
  const [offline, setOffline] = useState(false);
  const [emp, setEmp] = useState('');
  const [look, setLook] = useState<Lookup | null>(null);
  const [looking, setLooking] = useState(false);
  const [typedName, setTypedName] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [meal, setMeal] = useState<Meal | null>(null);
  const [attending, setAttending] = useState<boolean | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [done, setDone] = useState<Done | null>(null);
  const [flash, setFlash] = useState<Record<string, number>>({});
  const prev = useRef<Record<string, number>>(initial ? Object.fromEntries(initial.goodies.map((g) => [g.id, g.left])) : {});
  const inFlight = useRef(false);

  const apply = useCallback((f: Feed) => {
    const changed: Record<string, number> = {};
    for (const g of f.goodies) if (prev.current[g.id] !== undefined && prev.current[g.id] !== g.left) changed[g.id] = Date.now();
    prev.current = Object.fromEntries(f.goodies.map((g) => [g.id, g.left]));
    if (Object.keys(changed).length) setFlash((x) => ({ ...x, ...changed }));
    setFeed(f);
    setOffline(false);
  }, []);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch('/api/survey/feed', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      apply(await res.json());
    } catch { setOffline(true); } finally { inFlight.current = false; }
  }, [apply]);

  useEffect(() => {
    try { setDone(JSON.parse(localStorage.getItem(DONE_KEY) ?? 'null')); } catch { /* */ }
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
    const vis = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); };
  }, [load]);

  // employee ID → name, as they type (debounced)
  useEffect(() => {
    const id = emp.trim();
    setLook(null);
    if (id.length < 2) { setLooking(false); return; }
    setLooking(true);
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/survey/lookup?emp=${encodeURIComponent(id)}`, { cache: 'no-store', signal: ctl.signal });
        if (r.ok) setLook(await r.json());
      } catch { /* aborted or offline */ } finally { if (!ctl.signal.aborted) setLooking(false); }
    }, 350);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [emp]);

  const picked = feed?.goodies.find((g) => g.id === pick) ?? null;
  useEffect(() => {
    if (pick && feed && (!picked || picked.left <= 0)) {
      setNote(`${picked?.name ?? 'That goodie'} just ran out — please pick another.`);
      setPick(null);
      setConfirm(false);
    }
  }, [feed, pick, picked]);

  const listRequired = look?.list_required ?? feed?.list_required ?? false;
  const name = look?.found ? look.name ?? '' : typedName;
  const idOk = !!look && !looking && !look.chosen && !look.declined && (look.found || !listRequired);
  const ready = idOk && name.trim().length >= 2 && attending !== null && (attending === false || (!!picked && !!meal)) && !!feed?.open;

  async function submit() {
    if (attending && !picked) return;
    setBusy(true); setErr('');
    try {
      const r = await api<Done & { feed: Feed }>('/api/survey/submit', { body: { employee_id: emp, name, goodie_id: attending ? picked?.id : null, meal: attending ? meal : null, attending } });
      apply(r.feed);
      const d = { goodie: r.goodie, name: r.name, employee_id: r.employee_id, meal: r.meal ?? meal, attending: r.attending ?? attending };
      try { localStorage.setItem(DONE_KEY, JSON.stringify(d)); } catch { /* private mode */ }
      setDone(d);
      setConfirm(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      setConfirm(false);
      if (e instanceof ApiError && e.code === 'OUT_OF_STOCK') { setPick(null); load(); }
      setErr(e instanceof ApiError ? e.message : 'Network problem — please try again.');
    } finally { setBusy(false); }
  }

  const totalLeft = feed?.goodies.reduce((s, g) => s + g.left, 0) ?? 0;

  return (
    <div className="min-h-screen bg-slate-50 pb-28">
      <header className="bg-gradient-to-br from-brand-700 via-brand-600 to-indigo-500 px-4 pb-16 pt-8 text-white">
        <div className="mx-auto max-w-3xl">
          <p className="text-xs font-bold uppercase tracking-[0.25em] text-white/70">{feed?.event ?? 'Gen AI Designathon'}</p>
          <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">Pick your goodie 🎁</h1>
          <p className="mt-1 text-white/85">Enter your employee ID, confirm if you’re coming, then pick your goodie.</p>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 font-semibold backdrop-blur">
              <span className={`h-2 w-2 rounded-full ${offline ? 'bg-amber-300' : 'animate-pulse bg-emerald-300'}`} />
              {offline ? 'Reconnecting…' : 'Live'}
            </span>
            {feed && <span className="rounded-full bg-white/15 px-3 py-1 backdrop-blur">{totalLeft} left</span>}
            {!!feed?.chosen_total && <span className="rounded-full bg-white/15 px-3 py-1 backdrop-blur">{feed.chosen_total} picked so far</span>}
          </div>
        </div>
      </header>

      <main className="mx-auto -mt-10 max-w-3xl space-y-4 px-4">
        {done ? (
          <section className="rounded-3xl bg-white p-8 text-center shadow-lg ring-1 ring-slate-200">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-3xl text-emerald-700">✓</div>
            <h2 className="mt-4 text-2xl font-black">{done.goodie ? 'You’re all set' : 'Noted'}, {done.name.split(' ')[0]}!</h2>
            {done.goodie ? <p className="mt-2 text-slate-600">Your goodie: <strong className="text-slate-900">{done.goodie}</strong></p>
              : <p className="mt-2 text-slate-600">Thanks for letting us know you can’t attend on 27 November.</p>}
            {done.meal && <p className="mt-1 text-slate-600">Meal: <strong className="text-slate-900">{MEAL_LABEL[done.meal]}</strong></p>}
            {done.goodie && done.attending != null && <p className="mt-1 text-slate-600">Attending on 27 Nov: <strong className="text-slate-900">{done.attending ? 'Yes' : 'No'}</strong></p>}
            <p className="mt-1 text-sm text-slate-500">Employee ID {done.employee_id}</p>
            <button className="mt-6 text-xs text-slate-400 underline" onClick={() => { try { localStorage.removeItem(DONE_KEY); } catch { /* */ } setDone(null); setEmp(''); setPick(null); setTypedName(''); setMeal(null); setAttending(null); }}>
              Choosing for someone else on this phone?
            </button>
          </section>
        ) : (
          <>
            {feed && !feed.open && (
              <div className="rounded-2xl bg-amber-50 p-4 text-sm font-medium text-amber-900 shadow ring-1 ring-amber-200">
                Choosing isn’t open right now. You can see what’s available — come back when it opens.
              </div>
            )}

            <section className="rounded-3xl bg-white p-5 shadow-lg ring-1 ring-slate-200">
              <label className="block text-xs font-bold uppercase tracking-wide text-slate-500" htmlFor="emp">Your employee ID</label>
              <input id="emp" className="input mt-1 h-12 text-lg font-semibold tracking-wide" value={emp}
                onChange={(e) => { setEmp(e.target.value.toUpperCase().replace(/\s/g, '')); setErr(''); }}
                maxLength={40} autoCapitalize="characters" autoComplete="off" placeholder="e.g. EMP10234" />
              <div className="mt-3 min-h-[3rem]">
                {looking && <p className="text-sm text-slate-400">Checking…</p>}
                {!looking && look?.chosen && (
                  <div className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900 ring-1 ring-emerald-200">
                    <strong>{look.name ?? look.employee_id}</strong> has already chosen <strong>{look.chosen}</strong>. Only one goodie per person.
                  </div>
                )}
                {!looking && look?.declined && (
                  <div className="rounded-xl bg-slate-100 p-3 text-sm text-slate-800 ring-1 ring-slate-200">
                    <strong>{look.name ?? look.employee_id}</strong> has already told us they can’t attend. Contact the organizers to change this.
                  </div>
                )}
                {!looking && look && !look.chosen && !look.declined && look.found && (
                  <div className="flex items-center gap-3 rounded-xl bg-brand-50 p-3 ring-1 ring-brand-100">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-600 text-lg font-black text-white">{(look.name ?? '?').charAt(0)}</span>
                    <div><p className="text-xs text-slate-500">Hi there 👋</p><p className="font-bold text-slate-900">{look.name}</p></div>
                    <span className="ml-auto text-xl text-emerald-600">✓</span>
                  </div>
                )}
                {!looking && look && !look.chosen && !look.declined && !look.found && listRequired && (
                  <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-900 ring-1 ring-rose-200">
                    We couldn’t find <strong>{look.employee_id}</strong> in the participant list. Check the ID, or contact the organizers.
                  </div>
                )}
                {!looking && look && !look.chosen && !look.declined && !look.found && !listRequired && (
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wide text-slate-500" htmlFor="nm">Your full name</label>
                    <input id="nm" className="input mt-1 h-12" value={typedName} onChange={(e) => setTypedName(e.target.value)} maxLength={100} autoComplete="name" placeholder="Your name" />
                  </div>
                )}
                {!look && !looking && <p className="text-sm text-slate-400">Your name will appear once we find your ID.</p>}
              </div>
            </section>

            <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Will you attend on Friday, 27 November?</h2>
              <div className="mt-3 grid grid-cols-2 gap-3" role="radiogroup" aria-label="Attending on 27 November">
                {([true, false] as const).map((v) => (
                  <button key={String(v)} type="button" role="radio" aria-checked={attending === v} onClick={() => setAttending(v)}
                    className={`rounded-2xl px-4 py-4 text-lg font-bold ring-2 transition active:scale-[0.98] ${attending === v
                      ? (v ? 'bg-brand-50 text-brand-800 ring-brand-600' : 'bg-slate-100 text-slate-800 ring-slate-500')
                      : 'bg-white text-slate-700 ring-slate-200'}`}>
                    {v ? '✓ Yes, I’ll be there' : 'No'}
                  </button>
                ))}
              </div>
            </section>

            {attending === false && (
              <div className="rounded-2xl bg-slate-100 p-4 text-sm text-slate-700 ring-1 ring-slate-200">
                No problem — tap <strong>Submit</strong> to let us know you can’t make it. No goodie or meal will be booked for you.
              </div>
            )}

            {attending === true && (<>
            <section>
              <h2 className="mb-2 mt-2 px-1 text-sm font-bold uppercase tracking-wide text-slate-500">Tap one goodie</h2>
              {note && <div className="mb-3 rounded-xl bg-amber-50 p-3 text-sm font-medium text-amber-900 ring-1 ring-amber-200">{note}</div>}
              {err && <div className="mb-3 rounded-xl bg-rose-50 p-3 text-sm font-medium text-rose-900 ring-1 ring-rose-200">{err}</div>}
              {!feed && !offline && <p className="py-12 text-center text-slate-400">Loading goodies…</p>}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {feed?.goodies.map((g) => {
                  const out = g.left <= 0;
                  const sel = pick === g.id;
                  const changed = flash[g.id] && Date.now() - flash[g.id] < 2500;
                  const pct = g.stock ? Math.round((g.left / g.stock) * 100) : 0;
                  return (
                    <button key={g.id} type="button" disabled={out || !feed.open}
                      onClick={() => { setPick(g.id); setNote(''); setErr(''); }} aria-pressed={sel}
                      className={`relative overflow-hidden rounded-2xl bg-white text-left shadow-sm ring-2 transition active:scale-[0.98] ${sel ? 'ring-brand-600 shadow-lg' : 'ring-transparent'} ${out ? 'opacity-50 grayscale' : 'hover:shadow-md'} disabled:cursor-not-allowed`}>
                      <div className="aspect-square w-full bg-slate-100">
                        {g.image
                          // eslint-disable-next-line @next/next/no-img-element
                          ? <img src={g.image} alt={g.name} className="h-full w-full object-cover" loading="lazy" />
                          : <div className="flex h-full items-center justify-center text-5xl text-slate-300">🎁</div>}
                      </div>
                      {sel && <span className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 font-bold text-white shadow">✓</span>}
                      {out && <span className="absolute left-2 top-2 rounded-full bg-rose-600 px-2.5 py-1 text-xs font-bold text-white">Not available</span>}
                      <div className="p-3">
                        <p className="font-bold leading-tight">{g.name}</p>
                        {g.description && <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{g.description}</p>}
                        <p className={`mt-2 text-sm font-bold tabular-nums transition-colors ${out ? 'text-rose-600' : pct <= 15 ? 'text-amber-600' : 'text-emerald-700'} ${changed ? 'rounded bg-yellow-100 px-1' : ''}`}>
                          {out ? 'All gone' : `${g.left} of ${g.stock} left`}
                        </p>
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                          <div className={`h-full rounded-full transition-all duration-700 ${pct <= 15 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              {feed && feed.goodies.length === 0 && <p className="py-12 text-center text-slate-500">No goodies have been added yet.</p>}
            </section>

            <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Your meal preference</h2>
              <div className="mt-3 grid grid-cols-2 gap-3" role="radiogroup" aria-label="Meal preference">
                {(['veg', 'nonveg'] as const).map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={meal === m} onClick={() => setMeal(m)}
                    className={`flex items-center justify-center gap-2 rounded-2xl px-4 py-4 text-lg font-bold ring-2 transition active:scale-[0.98] ${meal === m
                      ? (m === 'veg' ? 'bg-emerald-50 text-emerald-800 ring-emerald-600' : 'bg-rose-50 text-rose-800 ring-rose-600')
                      : 'bg-white text-slate-700 ring-slate-200'}`}>
                    <span className={`flex h-5 w-5 items-center justify-center rounded-sm border-2 ${m === 'veg' ? 'border-emerald-600' : 'border-rose-700'}`}>
                      <span className={`h-2.5 w-2.5 rounded-full ${m === 'veg' ? 'bg-emerald-600' : 'bg-rose-700'}`} />
                    </span>
                    {MEAL_LABEL[m]}
                  </button>
                ))}
              </div>
            </section>
            </>)}

          </>
        )}
      </main>

      {!done && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 p-3 backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-center gap-3">
            <p className="min-w-0 flex-1 truncate text-sm text-slate-600">
              {!idOk ? 'Enter your employee ID' : attending === null ? 'Will you attend on 27 Nov?' : attending === false ? 'Not attending on 27 Nov' : !picked ? 'Tap a goodie' : !meal ? 'Choose Veg or Non-veg' : <><strong className="text-slate-900">{picked.name}</strong> · {MEAL_LABEL[meal]}</>}
            </p>
            <Button className="px-6" disabled={!ready} onClick={() => { setErr(''); setConfirm(true); }}>Submit</Button>
          </div>
        </div>
      )}

      <Modal open={confirm && (attending === false || !!picked)} title="Confirm" onClose={() => setConfirm(false)}>
        {(attending === false || picked) && (
          <div className="space-y-3">
            {attending === false ? <p><strong>{name.trim()}</strong> ({emp}) will <strong>not attend</strong> on 27 November. No goodie or meal will be booked.</p> : picked && <>
            <p><strong>{name.trim()}</strong> ({emp}) is choosing <strong>{picked.name}</strong>{meal && <> with a <strong>{MEAL_LABEL[meal]}</strong> meal</>}.</p>
            </>}
            <p className="text-sm text-slate-500">One submission per person — it can’t be changed afterwards.</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirm(false)}>Back</Button>
              <Button busy={busy} onClick={submit}>Yes, submit</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
