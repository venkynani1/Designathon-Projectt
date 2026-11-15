/**
 * Event-day load test: 250 teams (1000 participants) hitting a RUNNING server at once,
 * all from ONE IP address (like a venue behind a single NAT / Wi-Fi).
 *
 *   DX_LOAD_BASE_URL=http://localhost:3123 DX_LOAD_DATABASE_URL=postgres://.../dx_load \
 *   DX_PIN_PEPPER=... DX_VAULT_KEY=... npx vitest run tests/load
 *
 * The server must use the same database and the same DX_PIN_PEPPER / DX_VAULT_KEY.
 * Skipped unless both URLs are set.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { pgDb } from '@/lib/pgDb';
import { provisionTeams } from '@/lib/services/provisioning';
import { open, type PackagePayload } from '@/lib/crypto/vault';

const BASE = process.env.DX_LOAD_BASE_URL;
const DBURL = process.env.DX_LOAD_DATABASE_URL;
const TEAMS = Number(process.env.DX_LOAD_TEAMS ?? 250);
const CONCURRENCY = Number(process.env.DX_LOAD_CONCURRENCY ?? 200);
const run = BASE && DBURL ? describe : describe.skip;

type Sample = { ep: string; ms: number; status: number };
const samples: Sample[] = [];

async function call(cookie: { c: string }, ep: string, path: string, body?: unknown) {
  const t0 = performance.now();
  const res = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', origin: BASE!, cookie: cookie.c },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie.c = set.split(';')[0];
  const json = await res.json().catch(() => null);
  samples.push({ ep, ms: performance.now() - t0, status: res.status });
  return { status: res.status, json };
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

const pct = (xs: number[], p: number) => xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

run(`event-day load: ${TEAMS} teams / ${TEAMS * 4} participants from one IP`, () => {
  const pgPool = new pg.Pool({ connectionString: DBURL, max: 10 });
  pgPool.on('connect', (c) => void c.query('set role service_role'));
  const db = pgDb(pgPool);
  afterAll(() => pgPool.end());
  const key = (n: string) => Buffer.from(process.env[n]!, 'base64');

  it('handles the rush with zero errors and exact, oversell-free results', async () => {
    const ev = (await pgPool.query(`select id from events where code = $1`, [process.env.DX_EVENT_CODE ?? 'designathon-x'])).rows[0].id as string;
    const actor = randomUUID();
    const pins = new Map<string, string>();
    const teams: { team_id: string; team_number: number }[] = [];
    for (let left = TEAMS; left > 0; left -= 100) {
      const r = await provisionTeams(db, { eventId: ev, count: Math.min(100, left), actorId: actor, ttlHours: 2, secrets: { pepper: key('DX_PIN_PEPPER'), vaultKey: key('DX_VAULT_KEY') } });
      teams.push(...r.teams);
      const [box] = await db.rpc<{ id: string; ciphertext: string; iv: string; auth_tag: string }[]>('package_secrets', { p_event: ev, p_packages: [r.package_id] });
      for (const [k, v] of Object.entries(open<PackagePayload>(box, key('DX_VAULT_KEY'), box.id).credentials)) pins.set(k, v);
    }
    const people: { emp: string; pin: string }[] = [];
    const teamLogins: { n: number; pin: string }[] = [];
    await pool(teams, 20, async (t) => {
      const members = [1, 2, 3, 4].map((s) => ({ name: `Person ${t.team_number}-${s}`, employee_id: `L${String(t.team_number).padStart(4, '0')}${s}` }));
      await db.rpc('register_walk_in', { p_event: ev, p_team: t.team_id, p_name: `Load Team ${t.team_number}`, p_members: members, p_actor: actor });
      const creds = (await pgPool.query(
        `select c.id, c.subject_type, s.slot_number from credential_records c left join participant_slots s on s.id = c.slot_id where c.team_id = $1 and c.status = 'active'`, [t.team_id])).rows;
      for (const c of creds) {
        if (c.subject_type === 'team') teamLogins.push({ n: t.team_number, pin: pins.get(c.id)! });
        else people.push({ emp: `L${String(t.team_number).padStart(4, '0')}${c.slot_number}`, pin: pins.get(c.id)! });
      }
    });
    const nProblems = 10;
    const cap = Math.ceil((TEAMS * 1.2) / nProblems);
    for (let i = 1; i <= nProblems; i++) {
      await pgPool.query(`insert into problem_statements (event_id, code, title, capacity, sort_order) values ($1, $2, $3, $4, $5)`, [ev, `LD-${i}`, `Load problem ${i}`, cap, i]);
    }
    await pgPool.query(`insert into goodies (event_id, name, stock) values ($1, 'Hoodie', $2), ($1, 'Bottle', $3), ($1, 'Kit', $3)`, [ev, Math.floor(TEAMS * 1.2), Math.floor(TEAMS * 1.6)]);
    await db.rpc('set_event_flags', { p_event: ev, p_flags: { problems_open: true, goodies_open: true }, p_actor: actor });

    const t0 = performance.now();
    const participantFlow = async (p: { emp: string; pin: string }, i: number) => {
      const jar = { c: '' };
      if (i % 10 === 0) await call(jar, 'goodies/login (typo)', '/api/arena/goodies/login', { employee_id: p.emp, pin: p.pin === '135792' ? '246813' : '135792' });
      const login = await call(jar, 'goodies/login', '/api/arena/goodies/login', { employee_id: p.emp.toLowerCase(), pin: p.pin });
      if (login.status !== 200) return;
      const st = await call(jar, 'goodies/state', '/api/arena/goodies/state');
      const options = (st.json?.goodies ?? []) as { id: string }[];
      for (let k = 0; k < options.length; k++) {
        const r = await call(jar, 'goodies/reserve', '/api/arena/goodies/reserve', { goodie_id: options[(i + k) % options.length].id });
        if (r.status === 200 || r.json?.error?.code !== 'OUT_OF_STOCK') break;
      }
      await call(jar, 'goodies/reserve (double-tap)', '/api/arena/goodies/reserve', { goodie_id: options[0].id });
    };
    const teamFlow = async (t: { n: number; pin: string }, device: number) => {
      const jar = { c: '' };
      await call(jar, 'teams directory', `/api/arena/teams?q=${t.n}`);
      const login = await call(jar, 'problems/login', '/api/arena/problems/login', { team_number: t.n, pin: t.pin });
      if (login.status !== 200) return;
      const st = await call(jar, 'problems/state', '/api/arena/problems/state');
      const probs = (st.json?.problems ?? []) as { id: string }[];
      for (let k = 0; k < probs.length; k++) {
        const r = await call(jar, 'problems/lock', '/api/arena/problems/lock', { problem_id: probs[(t.n * 3 + device + k) % probs.length].id });
        if (r.status === 200 || r.json?.error?.code !== 'PROBLEM_FULL') break;
      }
      await call(jar, 'problems/state', '/api/arena/problems/state');
    };
    const jobs: (() => Promise<void>)[] = [
      ...people.map((p, i) => () => participantFlow(p, i)),
      ...teamLogins.flatMap((t) => [() => teamFlow(t, 0), () => teamFlow(t, 1)]), // two phones per team
    ].sort(() => Math.random() - 0.5);
    await pool(jobs, CONCURRENCY, (j) => j());
    const secs = (performance.now() - t0) / 1000;

    // ---- report
    const byEp = new Map<string, Sample[]>();
    for (const s of samples) byEp.set(s.ep, [...(byEp.get(s.ep) ?? []), s]);
    const rows = [...byEp].map(([ep, xs]) => ({
      endpoint: ep, requests: xs.length,
      statuses: [...new Set(xs.map((x) => x.status))].sort().map((st) => `${st}×${xs.filter((x) => x.status === st).length}`).join(' '),
      p50_ms: Math.round(pct(xs.map((x) => x.ms), 50)), p95_ms: Math.round(pct(xs.map((x) => x.ms), 95)), max_ms: Math.round(Math.max(...xs.map((x) => x.ms))),
    }));
    console.table(rows);
    console.log(`${samples.length} requests in ${secs.toFixed(1)} s (${Math.round(samples.length / secs)} req/s) at concurrency ${CONCURRENCY}`);

    // ---- correctness under load
    expect(samples.filter((s) => s.status >= 500)).toHaveLength(0);
    expect(samples.filter((s) => s.status === 429)).toHaveLength(0);
    const reservations = (await pgPool.query(`select count(*)::int c, count(distinct employee_id)::int d from goodie_reservations where event_id = $1`, [ev])).rows[0];
    expect(reservations.c).toBe(people.length);
    expect(reservations.d).toBe(people.length);
    const oversold = (await pgPool.query(`select g.name from goodies g where g.event_id = $1 and (select count(*) from goodie_reservations r where r.goodie_id = g.id) > g.stock`, [ev])).rows;
    expect(oversold).toHaveLength(0);
    const assignments = (await pgPool.query(`select count(*)::int c from problem_assignments where event_id = $1`, [ev])).rows[0].c;
    expect(assignments).toBe(TEAMS);
    const overCap = (await pgPool.query(`select p.code from problem_statements p where p.event_id = $1 and (select count(*) from problem_assignments a where a.problem_id = p.id) > p.capacity`, [ev])).rows;
    expect(overCap).toHaveLength(0);
  }, 600_000);
});
