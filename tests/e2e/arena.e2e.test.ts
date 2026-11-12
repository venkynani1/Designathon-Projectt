/**
 * End-to-end smoke test against a RUNNING server (next start) that uses the same database.
 * Skipped unless DX_E2E_BASE_URL and DX_E2E_DATABASE_URL are set. The server must share
 * DX_PIN_PEPPER / DX_VAULT_KEY with this process. See README "End-to-end smoke test".
 */
import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { pgDb } from '@/lib/pgDb';
import { provisionTeams } from '@/lib/services/provisioning';
import { open, type PackagePayload } from '@/lib/crypto/vault';

const BASE = process.env.DX_E2E_BASE_URL;
const DBURL = process.env.DX_E2E_DATABASE_URL;
const run = BASE && DBURL ? describe : describe.skip;

run('arena HTTP flow', () => {
  const pool = new pg.Pool({ connectionString: DBURL });
  pool.on('connect', (c) => void c.query('set role service_role'));
  const db = pgDb(pool);
  afterAll(() => pool.end());
  const key = (n: string) => Buffer.from(process.env[n]!, 'base64');

  class Jar {
    c = '';
    async req(path: string, init: { method?: string; body?: unknown; origin?: string } = {}) {
      const res = await fetch(BASE + path, {
        method: init.method ?? (init.body ? 'POST' : 'GET'),
        headers: { 'content-type': 'application/json', origin: init.origin ?? BASE!, cookie: this.c },
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) this.c = set.split(';')[0];
      return { status: res.status, json: await res.json().catch(() => null) };
    }
  }

  it('team login → shared state across devices → lock once; participant login → reserve once', async () => {
    const ev = (await pool.query(`select id from events where code = $1`, [process.env.DX_EVENT_CODE ?? 'designathon-x'])).rows[0].id;
    const admin = randomUUID();
    const prov = await provisionTeams(db, { eventId: ev, count: 2, actorId: admin, ttlHours: 1, secrets: { pepper: key('DX_PIN_PEPPER'), vaultKey: key('DX_VAULT_KEY') } });
    const [box] = await db.rpc<{ id: string; ciphertext: string; iv: string; auth_tag: string }[]>('package_secrets', { p_event: ev, p_packages: [prov.package_id] });
    const pins = open<PackagePayload>(box, key('DX_VAULT_KEY'), box.id).credentials;
    const t = prov.teams[0];
    const sfx = Date.now().toString(36).toUpperCase();
    await db.rpc('register_walk_in', { p_event: ev, p_team: t.team_id, p_name: `E2E ${sfx}`, p_members: [{ name: 'Arun', employee_id: `A${sfx}` }, { name: 'Priya', employee_id: `P${sfx}` }], p_actor: admin });
    await db.rpc('set_event_flags', { p_event: ev, p_flags: { problems_open: true, goodies_open: true }, p_actor: admin });
    const teamCred = (await pool.query(`select id from credential_records where team_id = $1 and subject_type = 'team'`, [t.team_id])).rows[0].id;
    const p1Cred = (await pool.query(`select c.id from credential_records c join participant_slots s on s.id = c.slot_id where s.team_id = $1 and s.slot_number = 1`, [t.team_id])).rows[0].id;

    const phone = new Jar();
    const laptop = new Jar();
    expect((await phone.req('/api/arena/problems/state')).status).toBe(401);
    expect((await phone.req('/api/arena/problems/login', { body: { team_number: t.team_number, pin: '000001' } })).status).toBe(401);
    expect((await phone.req('/api/arena/problems/login', { body: { team_number: t.team_number, pin: pins[teamCred] }, origin: 'https://evil.example' })).status).toBe(403);
    expect((await phone.req('/api/arena/problems/login', { body: { team_number: t.team_number, pin: pins[teamCred] } })).status).toBe(200);
    expect((await laptop.req('/api/arena/problems/login', { body: { team_number: t.team_number, pin: pins[teamCred] } })).status).toBe(200);
    const st = await phone.req('/api/arena/problems/state');
    expect(st.status).toBe(200);
    const problem = st.json.problems[0];
    const [a, b] = await Promise.all([
      phone.req('/api/arena/problems/lock', { body: { problem_id: problem.id } }),
      laptop.req('/api/arena/problems/lock', { body: { problem_id: st.json.problems[1].id } }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const s1 = await phone.req('/api/arena/problems/state');
    const s2 = await laptop.req('/api/arena/problems/state');
    expect(s1.json.assignment.problem_id).toBe(s2.json.assignment.problem_id);

    const me = new Jar();
    expect((await me.req('/api/arena/goodies/login', { body: { employee_id: `a${sfx}`.toLowerCase(), pin: pins[p1Cred] } })).status).toBe(200);
    const gs = await me.req('/api/arena/goodies/state');
    expect(gs.json.participant.name).toBe('Arun');
    const g = gs.json.goodies[0];
    expect((await me.req('/api/arena/goodies/reserve', { body: { goodie_id: g.id } })).status).toBe(200);
    const again = await me.req('/api/arena/goodies/reserve', { body: { goodie_id: gs.json.goodies[1].id } });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('ALREADY_RESERVED');
    expect((await me.req('/api/arena/goodies/logout', { body: {} })).status).toBe(200);
    expect((await me.req('/api/arena/goodies/state')).status).toBe(401);
    // admin APIs refuse anonymous callers
    expect((await me.req('/api/admin/teams')).status).toBe(401);
  });
});
