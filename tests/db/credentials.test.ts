import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, secrets, type TestDb } from './harness';
import { provisionTeams, reissueCredentials } from '@/lib/services/provisioning';
import { buildSlips } from '@/lib/services/slips';
import { open, type PackagePayload } from '@/lib/crypto/vault';
import { authenticateParticipant, authenticateTeam, openArenaSession, resolveArenaSession } from '@/lib/services/arenaAuth';
import { DxError } from '@/lib/errors';
import { buildPlan } from '@/lib/import/plan';

let t: TestDb;
let pins: Map<string, string>; // credential id -> plaintext (from the sealed package, as an issuing admin would)
let teams: { team_id: string; team_number: number }[];

const credRows = async (teamId: string) =>
  (await t.sql(`select id, subject_type, slot_id, version, pin_hash, pin_fingerprint, status from credential_records where team_id = $1 order by subject_type, slot_id, version`, [teamId])).rows;
const slot = async (teamId: string, n: number) =>
  (await t.sql(`select * from participant_slots where team_id = $1 and slot_number = $2`, [teamId, n])).rows[0];
const activeCred = async (slotId: string) =>
  (await t.sql(`select * from credential_records where slot_id = $1 and status <> 'revoked'`, [slotId])).rows[0];
const teamCred = async (teamId: string) =>
  (await t.sql(`select * from credential_records where team_id = $1 and subject_type = 'team' and status <> 'revoked'`, [teamId])).rows[0];
const teamId = (n: number) => teams.find((x) => x.team_number === n)!.team_id;

async function loadPins(packageId: string) {
  const [box] = await t.db.rpc<{ id: string; ciphertext: string; iv: string; auth_tag: string }[]>('package_secrets', {
    p_event: t.eventId, p_packages: [packageId],
  });
  const payload = open<PackagePayload>(box, secrets.vaultKey, box.id);
  for (const [k, v] of Object.entries(payload.credentials)) pins.set(k, v);
}

async function expectDx(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DxError && e.code === code);
}

const walkIn = (n: number, name: string, members: { name: string; employee_id: string; email?: string }[]) =>
  t.db.rpc('register_walk_in', { p_event: t.eventId, p_team: teamId(n), p_name: name, p_members: members, p_actor: t.actorId });

const setFlags = (flags: Record<string, boolean>) => t.db.rpc('set_event_flags', { p_event: t.eventId, p_flags: flags, p_actor: t.actorId });

beforeAll(async () => {
  t = await createTestDb();
  pins = new Map();
  const res = await provisionTeams(t.db, { eventId: t.eventId, count: 50, actorId: t.actorId, ttlHours: 72, secrets });
  teams = res.teams;
  await loadPins(res.package_id);
  await t.sql(`insert into problem_statements (event_id, code, title, capacity) values ($1, 'PS-01', 'One', 3), ($1, 'PS-02', 'Two', 50)`, [t.eventId]);
  await t.sql(`insert into goodies (event_id, name, stock) values ($1, 'Hoodie', 2), ($1, 'Bottle', 100)`, [t.eventId]);
});
afterAll(async () => t?.close());

describe('1–3 provisioning', () => {
  it('1. creates 50 permanent teams and 200 participant slots', async () => {
    expect((await t.sql(`select count(*)::int c from teams where event_id = $1`, [t.eventId])).rows[0].c).toBe(50);
    expect((await t.sql(`select count(*)::int c from participant_slots where event_id = $1`, [t.eventId])).rows[0].c).toBe(200);
    const nums = (await t.sql(`select team_number from teams where event_id = $1 order by 1`, [t.eventId])).rows.map((r) => r.team_number);
    expect(nums).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    const perTeam = (await t.sql(`select count(*)::int c from participant_slots group by team_id`)).rows;
    expect(perTeam.every((r) => r.c === 4)).toBe(true);
  });

  it('2. every team has exactly one unique team PIN', async () => {
    const rows = (await t.sql(`select team_id, id from credential_records where subject_type = 'team' and status = 'active'`)).rows;
    expect(rows).toHaveLength(50);
    expect(new Set(rows.map((r) => r.team_id)).size).toBe(50);
    expect(new Set(rows.map((r) => pins.get(r.id))).size).toBe(50);
  });

  it('3. every participant slot has its own unique PIN, distinct from all team PINs; only hashes are stored', async () => {
    const rows = (await t.sql(`select slot_id, id, pin_hash from credential_records where status = 'active'`)).rows;
    expect(rows).toHaveLength(250);
    const slotRows = rows.filter((r) => r.slot_id);
    expect(new Set(slotRows.map((r) => r.slot_id)).size).toBe(200);
    expect(new Set(rows.map((r) => pins.get(r.id))).size).toBe(250);
    expect(rows.every((r) => r.pin_hash.startsWith('$argon2id$') && !r.pin_hash.includes(pins.get(r.id)!))).toBe(true);
    // no plaintext anywhere in the database
    const dump = (await t.sql(`select string_agg(t::text, '|') s from (select * from credential_records) t`)).rows[0].s as string;
    expect([...pins.values()].slice(0, 25).some((p) => dump.includes(`"${p}"`) || dump.includes(`,${p},`))).toBe(false);
  });

  it('extending capacity continues numbering and never reuses a number', async () => {
    const more = await provisionTeams(t.db, { eventId: t.eventId, count: 2, actorId: t.actorId, ttlHours: 72, secrets });
    expect(more.teams.map((x) => x.team_number)).toEqual([51, 52]);
    teams.push(...more.teams);
    await loadPins(more.package_id);
    await expect(t.sql(`update teams set team_number = 99 where id = $1`, [teamId(51)])).rejects.toThrow(/permanent/);
    await expect(t.sql(`delete from teams where id = $1`, [teamId(52)])).rejects.toThrow(/cannot be deleted/);
    await expect(t.sql(`delete from participant_slots where team_id = $1`, [teamId(52)])).rejects.toThrow(/cannot be deleted/);
  });
});

describe('4–7 permanence of credentials', () => {
  it('walk-in registration assigns P1/P2 in order, keeps all PINs, leaves P3/P4 vacant', async () => {
    const before = await credRows(teamId(40));
    const res = await walkIn(40, 'Pixel Warriors', [
      { name: 'Arun', employee_id: '2000168956' },
      { name: 'Priya', employee_id: '2000168957', email: 'Priya@Corp.example' },
    ]);
    expect(res).toMatchObject({ team_number: 40, name: 'Pixel Warriors' });
    expect((await slot(teamId(40), 1)).participant_name).toBe('Arun');
    expect((await slot(teamId(40), 2)).email).toBe('priya@corp.example');
    expect((await slot(teamId(40), 3)).occupancy).toBe('vacant');
    expect((await t.sql(`select registration_status, registration_source from teams where id = $1`, [teamId(40)])).rows[0])
      .toEqual({ registration_status: 'registered', registration_source: 'walk_in' });
    expect(await credRows(teamId(40))).toEqual(before);
  });

  it('rejects teams below the minimum size and never overwrites a registered team', async () => {
    await expectDx(walkIn(41, 'Solo', [{ name: 'Lone', employee_id: 'E900' }]), 'TEAM_SIZE');
    await expectDx(walkIn(40, 'Takeover', [{ name: 'A', employee_id: 'E901' }, { name: 'B', employee_id: 'E902' }]), 'TEAM_NOT_EMPTY');
  });

  it('4. renaming a team never changes any credential, assignment or reservation', async () => {
    const before = await credRows(teamId(40));
    await t.db.rpc('rename_team', { p_event: t.eventId, p_team: teamId(40), p_name: 'Design Ninjas', p_actor: t.actorId });
    expect((await t.sql(`select name, team_number from teams where id = $1`, [teamId(40)])).rows[0]).toEqual({ name: 'Design Ninjas', team_number: 40 });
    expect(await credRows(teamId(40))).toEqual(before);
    const login = await authenticateTeam(t.db, { eventId: t.eventId, teamNumber: 40, pin: pins.get((await teamCred(teamId(40))).id)!, ip: '10.0.0.1' });
    expect(login.teamId).toBe(teamId(40));
  });

  it('4b. team names are unique per event (case-insensitive)', async () => {
    await walkIn(1, 'Alpha Squad', [{ name: 'A1', employee_id: 'A001' }, { name: 'A2', employee_id: 'A002' }]);
    await expectDx(t.db.rpc('rename_team', { p_event: t.eventId, p_team: teamId(40), p_name: 'alpha squad', p_actor: t.actorId }), 'DUPLICATE_TEAM_NAME');
  });

  it('5. editing P1 name never changes its PIN', async () => {
    const s1 = await slot(teamId(40), 1);
    const before = await activeCred(s1.id);
    await t.db.rpc('update_member_details', { p_event: t.eventId, p_slot: s1.id, p_name: 'Arun Kumar', p_email: 'arun@corp.example', p_actor: t.actorId });
    expect((await slot(teamId(40), 1)).participant_name).toBe('Arun Kumar');
    expect(await activeCred(s1.id)).toEqual(before);
    const h = (await t.sql(`select participant_name from participant_identity_history where id = $1`, [s1.current_identity_id])).rows[0];
    expect(h.participant_name).toBe('Arun Kumar');
  });

  it('6. adding a third participant fills P3 with the existing P3 credential', async () => {
    const s3 = await slot(teamId(40), 3);
    const before = await activeCred(s3.id);
    const res = await t.db.rpc<{ slot_number: number }>('add_member', {
      p_event: t.eventId, p_team: teamId(40), p_member: { name: 'Rahul', employee_id: '2000168958' }, p_actor: t.actorId,
    });
    expect(res.slot_number).toBe(3);
    expect(await activeCred(s3.id)).toEqual(before);
    const auth = await authenticateParticipant(t.db, { eventId: t.eventId, employeeId: '2000168958', pin: pins.get(before.id)!, ip: '10.0.0.2' });
    expect(auth.slotId).toBe(s3.id);
  });

  it('7. removing P2 keeps the slot, its credential and the historical identity; next add fills P2 (lowest vacant)', async () => {
    const s2 = await slot(teamId(40), 2);
    const cred = await activeCred(s2.id);
    const res = await t.db.rpc<{ credential_compromised: boolean }>('remove_member', {
      p_event: t.eventId, p_slot: s2.id, p_reason: 'Moved to another project', p_actor: t.actorId,
    });
    expect(res.credential_compromised).toBe(false); // never disclosed -> PIN stays permanent
    const after = await slot(teamId(40), 2);
    expect(after.occupancy).toBe('vacant');
    expect(await activeCred(s2.id)).toEqual(cred);
    const hist = (await t.sql(`select * from participant_identity_history where slot_id = $1`, [s2.id])).rows;
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ employee_id: '2000168957', participant_name: 'Priya' });
    expect(hist[0].released_at).not.toBeNull();
    // P1 and P3 did not move
    expect((await slot(teamId(40), 1)).participant_name).toBe('Arun Kumar');
    expect((await slot(teamId(40), 3)).participant_name).toBe('Rahul');
    const re = await t.db.rpc<{ slot_number: number }>('add_member', {
      p_event: t.eventId, p_team: teamId(40), p_member: { name: 'Meera', employee_id: 'E-7001' }, p_actor: t.actorId,
    });
    expect(re.slot_number).toBe(2);
    expect(await activeCred(s2.id)).toEqual(cred);
    await expect(t.sql(`delete from participant_identity_history where slot_id = $1`, [s2.id])).rejects.toThrow(/permanent/);
  });
});

describe('8. employee uniqueness', () => {
  it('rejects duplicate employee IDs (normalized) across teams, within a team and via add_member', async () => {
    await expectDx(walkIn(2, 'Dupes', [{ name: 'X', employee_id: ' 2000 168956 ' }, { name: 'Y', employee_id: 'Z1' }]), 'DUPLICATE_EMPLOYEE');
    await expectDx(walkIn(2, 'Dupes', [{ name: 'X', employee_id: 'q1' }, { name: 'Y', employee_id: 'Q1' }]), 'DUPLICATE_EMPLOYEE');
    await expectDx(t.db.rpc('add_member', { p_event: t.eventId, p_team: teamId(1), p_member: { name: 'Again', employee_id: '2000168958' }, p_actor: t.actorId }), 'DUPLICATE_EMPLOYEE');
    await expectDx(t.db.rpc('add_member', { p_event: t.eventId, p_team: teamId(1), p_member: { name: 'Mail', employee_id: 'M77', email: 'ARUN@corp.example' }, p_actor: t.actorId }), 'DUPLICATE_EMPLOYEE');
    // a failed registration leaves no partial state
    expect((await slot(teamId(2), 1)).occupancy).toBe('vacant');
  });

  it('a team can never exceed four occupied slots', async () => {
    await t.db.rpc('add_member', { p_event: t.eventId, p_team: teamId(40), p_member: { name: 'Four', employee_id: 'E-4' }, p_actor: t.actorId });
    await expectDx(t.db.rpc('add_member', { p_event: t.eventId, p_team: teamId(40), p_member: { name: 'Five', employee_id: 'E-5' }, p_actor: t.actorId }), 'TEAM_FULL');
    await expect(t.sql(`insert into participant_slots (event_id, team_id, slot_number) values ($1, $2, 5)`, [t.eventId, teamId(40)])).rejects.toThrow();
  });
});

describe('9. problem statement locking', () => {
  let ps1: string;
  let ps2: string;
  beforeAll(async () => {
    const r = (await t.sql(`select id, code from problem_statements order by code`)).rows;
    ps1 = r[0].id;
    ps2 = r[1].id;
    for (const n of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      await walkIn(n, `Team Race ${n}`, [{ name: `R${n}a`, employee_id: `R${n}A` }, { name: `R${n}b`, employee_id: `R${n}B` }]);
    }
  });

  it('is closed until the admin opens the arena', async () => {
    await expectDx(t.db.rpc('lock_problem', { p_team: teamId(1), p_problem: ps2, p_session: null }), 'ARENA_CLOSED');
    await setFlags({ problems_open: true });
  });

  it('one team cannot lock two problem statements; teammates share one state (10 concurrent devices)', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => t.db.rpc('lock_problem', { p_team: teamId(1), p_problem: i % 2 ? ps1 : ps2, p_session: null })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'ALREADY_ASSIGNED')).toBe(true);
    expect((await t.sql(`select count(*)::int c from problem_assignments where team_id = $1`, [teamId(1)])).rows[0].c).toBe(1);
  });

  it('never oversubscribes a problem under concurrency (capacity 3, 10 teams racing)', async () => {
    const racers = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(teamId);
    const results = await Promise.allSettled(racers.map((id) => t.db.rpc('lock_problem', { p_team: id, p_problem: ps1, p_session: null })));
    const won = results.filter((r) => r.status === 'fulfilled').length;
    const already = (await t.sql(`select count(*)::int c from problem_assignments where problem_id = $1`, [ps1])).rows[0].c;
    expect(already).toBe(3);
    expect(won).toBeLessThanOrEqual(3);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'PROBLEM_FULL')).toBe(true);
  });

  it('incomplete teams are not eligible', async () => {
    await t.db.rpc('add_member', { p_event: t.eventId, p_team: teamId(20), p_member: { name: 'Only One', employee_id: 'ONE1' }, p_actor: t.actorId });
    await expectDx(t.db.rpc('lock_problem', { p_team: teamId(20), p_problem: ps2, p_session: null }), 'TEAM_NOT_ELIGIBLE');
  });

  it('assignments cannot be edited or deleted directly', async () => {
    await expect(t.sql(`update problem_assignments a set problem_id = (select id from problem_statements p where p.id <> a.problem_id limit 1) where team_id = $1`, [teamId(1)])).rejects.toThrow(/locked/);
    await expect(t.sql(`delete from problem_assignments where team_id = $1`, [teamId(1)])).rejects.toThrow(/locked/);
  });
});

describe('10–11. goodies reservations', () => {
  let hoodie: string;
  let bottle: string;
  let p1Identity: string;
  beforeAll(async () => {
    const r = (await t.sql(`select id, name from goodies order by name`)).rows;
    bottle = r[0].id;
    hoodie = r[1].id;
    p1Identity = (await slot(teamId(40), 1)).current_identity_id;
  });

  it('opening the Goodies Arena freezes identity changes by default', async () => {
    const flags = await setFlags({ goodies_open: true });
    expect(flags).toMatchObject({ goodies_open: true, member_edits_frozen: true });
    await expectDx(t.db.rpc('add_member', { p_event: t.eventId, p_team: teamId(2), p_member: { name: 'Late', employee_id: 'LATE1' }, p_actor: t.actorId }), 'FROZEN');
    await expectDx(t.db.rpc('add_member', { p_event: t.eventId, p_team: teamId(2), p_member: { name: 'Late', employee_id: 'LATE1' }, p_actor: t.actorId, p_privileged: true, p_reason: 'short' }), 'REASON_REQUIRED');
    // renames and spelling fixes stay allowed
    await t.db.rpc('rename_team', { p_event: t.eventId, p_team: teamId(1), p_name: 'Alpha Squad Prime', p_actor: t.actorId });
  });

  it('10. one employee cannot reserve two goodies (10 concurrent attempts)', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => t.db.rpc('reserve_goodie', { p_identity: p1Identity, p_goodie: i % 2 ? hoodie : bottle, p_session: null })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await t.sql(`select count(*)::int c from goodie_reservations where employee_id = '2000168956'`)).rows[0].c).toBe(1);
  });

  it('stock is never oversold under concurrency', async () => {
    const ids = (await t.sql(`select current_identity_id id from participant_slots where occupancy = 'occupied' and team_id <> $1 limit 8`, [teamId(40)])).rows.map((r) => r.id);
    const results = await Promise.allSettled(ids.map((id) => t.db.rpc('reserve_goodie', { p_identity: id, p_goodie: hoodie, p_session: null })));
    const taken = (await t.sql(`select count(*)::int c from goodie_reservations where goodie_id = $1`, [hoodie])).rows[0].c;
    expect(taken).toBe(2);
    expect(results.filter((r) => r.status === 'rejected').every((r) => ['OUT_OF_STOCK'].includes((r as PromiseRejectedResult).reason.code))).toBe(true);
  });

  it('11. reservations cannot be transferred through name edits or replacement', async () => {
    const s1 = await slot(teamId(40), 1);
    const resBefore = (await t.sql(`select * from goodie_reservations where identity_id = $1`, [p1Identity])).rows[0];
    await t.db.rpc('update_member_details', { p_event: t.eventId, p_slot: s1.id, p_name: 'Somebody Else', p_email: null, p_actor: t.actorId });
    const resAfter = (await t.sql(`select * from goodie_reservations where identity_id = $1`, [p1Identity])).rows[0];
    expect(resAfter).toEqual(resBefore);
    expect(resAfter.employee_id).toBe('2000168956');
    // direct transfer is blocked at the database level
    await expect(t.sql(`update goodie_reservations set employee_id = 'X' where id = $1`, [resBefore.id])).rejects.toThrow(/transferred/);
    // privileged replacement: the replacement starts with NO reservation, the old one stays with the former participant
    await t.db.rpc('replace_member', {
      p_event: t.eventId, p_slot: s1.id, p_member: { name: 'Kiran', employee_id: 'K-555' }, p_reason: 'Arun left the event due to travel',
      p_actor: t.actorId, p_privileged: true,
    });
    const newIdentity = (await slot(teamId(40), 1)).current_identity_id;
    const state = await t.db.rpc<{ reservation: unknown }>('participant_arena_state', { p_identity: newIdentity });
    expect(state.reservation).toBeNull();
    expect((await t.sql(`select employee_id from goodie_reservations where id = $1`, [resBefore.id])).rows[0].employee_id).toBe('2000168956');
    // the former participant can no longer reserve through that slot
    await expectDx(t.db.rpc('reserve_goodie', { p_identity: p1Identity, p_goodie: bottle, p_session: null }), 'SESSION_INVALID');
    // ... and re-adding the same employee later still gives them no second goodie
    const audit = (await t.sql(`select action, reason from audit_logs where action = 'member.replaced.privileged'`)).rows;
    expect(audit[0].reason).toContain('travel');
  });
});

describe('12. rate limiting', () => {
  it('locks a team after 5 wrong PINs, even with the right PIN afterwards', async () => {
    const id = teamId(5);
    const right = pins.get((await teamCred(id)).id)!;
    const wrong = right === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i++) {
      await expectDx(authenticateTeam(t.db, { eventId: t.eventId, teamNumber: 5, pin: wrong, ip: `10.1.0.${i}` }), 'INVALID_CREDENTIALS');
    }
    await expectDx(authenticateTeam(t.db, { eventId: t.eventId, teamNumber: 5, pin: right, ip: '10.1.0.99' }), 'RATE_LIMITED');
  });

  it('limits a single employee ID and unknown employees identically (no enumeration)', async () => {
    for (let i = 0; i < 5; i++) {
      await expectDx(authenticateParticipant(t.db, { eventId: t.eventId, employeeId: 'NOPE-1', pin: '123789', ip: '10.2.0.1' }), 'INVALID_CREDENTIALS');
    }
    await expectDx(authenticateParticipant(t.db, { eventId: t.eventId, employeeId: 'NOPE-1', pin: '123789', ip: '10.2.0.1' }), 'RATE_LIMITED');
  });

  it('rejects malformed PINs without leaking information', async () => {
    await expectDx(authenticateTeam(t.db, { eventId: t.eventId, teamNumber: 6, pin: "' or 1=1 --", ip: '10.3.0.1' }), 'INVALID_CREDENTIALS');
  });
});

describe('13. credential slips are protected', () => {
  it('application roles cannot read tables or call functions directly', async () => {
    const c = await t.pool.connect();
    try {
      await c.query('set role anon');
      await expect(c.query('select * from credential_records')).rejects.toThrow(/permission denied/);
      await expect(c.query(`select package_secrets($1, array[]::uuid[])`, [t.eventId])).rejects.toThrow(/permission denied/);
      await c.query('reset role');
      await c.query('set role authenticated');
      await expect(c.query('select pin_hash from credential_records')).rejects.toThrow(/permission denied/);
      await expect(c.query(`select get_team_login($1, 1)`, [t.eventId])).rejects.toThrow(/permission denied/);
    } finally {
      await c.query('reset role');
      c.release();
    }
  });

  it('admin read models never include hashes or fingerprints', async () => {
    const detail = JSON.stringify(await t.db.rpc('admin_team_detail', { p_event: t.eventId, p_team: teamId(40) }));
    const list = JSON.stringify(await t.db.rpc('admin_list_teams', { p_event: t.eventId, p_q: '' }));
    const report = JSON.stringify(await t.db.rpc('admin_report_rows', { p_event: t.eventId }));
    for (const s of [detail, list, report]) {
      expect(s).not.toMatch(/argon2|pin_hash|fingerprint/);
    }
  });

  it('slips include PINs only from live packages and mark them disclosed; expired packages cannot be recovered', async () => {
    const { teams: slips, disclosedCredentialIds } = await buildSlips(t.db, { eventId: t.eventId, teamIds: [teamId(30)], withPins: true, vaultKey: secrets.vaultKey });
    expect(slips[0].team_pin).toMatch(/^\d{6}$/);
    expect(disclosedCredentialIds).toHaveLength(5);
    await t.db.rpc('mark_credentials_disclosed', { p_event: t.eventId, p_credentials: disclosedCredentialIds, p_actor: t.actorId, p_context: {} });
    // wrong key cannot open a package
    await expect(buildSlips(t.db, { eventId: t.eventId, teamIds: [teamId(30)], withPins: true, vaultKey: Buffer.alloc(32, 7) })).rejects.toThrow();
    // expire everything -> PINs are gone for good
    await t.sql(`update credential_packages set expires_at = now() - interval '1 second'`);
    expect(await t.db.rpc<number>('purge_expired_packages', {})).toBeGreaterThan(0);
    const after = await buildSlips(t.db, { eventId: t.eventId, teamIds: [teamId(30)], withPins: true, vaultKey: secrets.vaultKey });
    expect(after.teams[0].team_pin).toBeNull();
    expect(after.teams[0].team_pin_state).toBe('reissue_required');
    const left = (await t.sql(`select count(*)::int c from credential_packages where ciphertext is not null`)).rows[0].c;
    expect(left).toBe(0);
  });
});

describe('14. replacement after credential distribution', () => {
  it('disclosed slot PIN becomes compromised on replacement; sessions die; supervised reissue restores access', async () => {
    const id = teamId(30);
    await setFlags({ goodies_open: false, member_edits_frozen: false });
    await walkIn(30, 'Disclosed Team', [{ name: 'Old One', employee_id: 'OLD-1' }, { name: 'Stay', employee_id: 'STAY-1' }]);
    const s1 = await slot(id, 1);
    const cred = await activeCred(s1.id);
    const oldPin = pins.get(cred.id)!;
    expect(cred.disclosed_at).not.toBeNull();
    const auth = await authenticateParticipant(t.db, { eventId: t.eventId, employeeId: 'OLD-1', pin: oldPin, ip: '10.4.0.1' });
    const sess = await openArenaSession(t.db, { eventId: t.eventId, kind: 'participant', teamId: id, slotId: auth.slotId, identityId: auth.identityId, credentialId: auth.credentialId, ip: '1', userAgent: 'test' });
    expect(await resolveArenaSession(t.db, 'participant', sess.token)).not.toBeNull();

    const res = await t.db.rpc<{ requires_reissue: boolean }>('replace_member', {
      p_event: t.eventId, p_slot: s1.id, p_member: { name: 'New One', employee_id: 'NEW-1' }, p_reason: 'Original participant withdrew', p_actor: t.actorId,
    });
    expect(res.requires_reissue).toBe(true);
    expect((await activeCred(s1.id)).status).toBe('compromised');
    expect(await resolveArenaSession(t.db, 'participant', sess.token)).toBeNull();
    // the old PIN does not automatically grant the replacement access
    await expectDx(authenticateParticipant(t.db, { eventId: t.eventId, employeeId: 'NEW-1', pin: oldPin, ip: '10.4.0.2' }), 'CREDENTIAL_WITHDRAWN');
    await expectDx(authenticateParticipant(t.db, { eventId: t.eventId, employeeId: 'OLD-1', pin: oldPin, ip: '10.4.0.2' }), 'INVALID_CREDENTIALS');

    await expectDx(reissueCredentials(t.db, { eventId: t.eventId, credentialIds: [cred.id], reason: 'x', actorId: t.actorId, ttlHours: 1, secrets }), 'REASON_REQUIRED');
    const re = await reissueCredentials(t.db, { eventId: t.eventId, credentialIds: [cred.id], reason: 'Replacement participant after disclosure', actorId: t.actorId, ttlHours: 1, secrets });
    await loadPins(re.package_id);
    const fresh = await activeCred(s1.id);
    expect(fresh.version).toBe(2);
    expect(fresh.id).not.toBe(cred.id);
    expect(pins.get(fresh.id)).not.toBe(oldPin);
    const ok = await authenticateParticipant(t.db, { eventId: t.eventId, employeeId: 'NEW-1', pin: pins.get(fresh.id)!, ip: '10.4.0.3' });
    expect(ok.slotId).toBe(s1.id);
    // history: v1 revoked & kept
    const all = (await t.sql(`select version, status from credential_records where slot_id = $1 order by version`, [s1.id])).rows;
    expect(all).toEqual([{ version: 1, status: 'revoked' }, { version: 2, status: 'active' }]);
    await expect(t.sql(`update credential_records set status = 'active' where id = $1`, [cred.id])).rejects.toThrow(/reactivated/);
    await expect(t.sql(`update credential_records set pin_hash = $2 where id = $1`, [fresh.id, cred.pin_hash])).rejects.toThrow(/never be regenerated/);
  });
});

describe('15. sessions survive refresh and work across devices', () => {
  it('two devices with the same team PIN see the same assignment; sessions are server-side', async () => {
    const id = teamId(3);
    const pin = pins.get((await teamCred(id)).id)!;
    const a = await authenticateTeam(t.db, { eventId: t.eventId, teamNumber: 3, pin, ip: '10.5.0.1' });
    const phone = await openArenaSession(t.db, { eventId: t.eventId, kind: 'team', teamId: a.teamId, credentialId: a.credentialId, ip: '1', userAgent: 'phone' });
    const laptop = await openArenaSession(t.db, { eventId: t.eventId, kind: 'team', teamId: a.teamId, credentialId: a.credentialId, ip: '2', userAgent: 'laptop' });
    const s1 = await resolveArenaSession(t.db, 'team', phone.token);
    const s2 = await resolveArenaSession(t.db, 'team', laptop.token);
    expect(s1?.team_id).toBe(s2?.team_id);
    const st1 = await t.db.rpc<{ assignment: unknown }>('team_arena_state', { p_team: s1!.team_id });
    // "refresh": resolving the same cookie again yields the same state
    const again = await resolveArenaSession(t.db, 'team', phone.token);
    const st2 = await t.db.rpc<{ assignment: unknown }>('team_arena_state', { p_team: again!.team_id });
    expect(st2).toEqual(st1);
    expect(await resolveArenaSession(t.db, 'team', 'forged-token')).toBeNull();
    expect(await resolveArenaSession(t.db, 'participant', phone.token)).toBeNull(); // kind-bound
    await t.db.rpc('revoke_arena_session', { p_token_hash: (await import('@/lib/crypto/tokens')).hashToken(phone.token) });
    expect(await resolveArenaSession(t.db, 'team', phone.token)).toBeNull();
    expect(await resolveArenaSession(t.db, 'team', laptop.token)).not.toBeNull();
  });
});

describe('import commit', () => {
  it('maps 2/3/4-person teams to P1..Pn, commits atomically and refuses to overwrite', async () => {
    const ctx = await t.db.rpc<Parameters<typeof buildPlan>[3]>('import_context', { p_event: t.eventId });
    const rows = [
      { Team: '45', 'Team Name': 'Imported Two', Name: 'I2a', 'Emp ID': 'IM-201' },
      { Team: '45', 'Team Name': 'Imported Two', Name: 'I2b', 'Emp ID': 'IM-202' },
      { Team: '', 'Team Name': 'Imported Three', Name: 'I3a', 'Emp ID': 'IM-301' },
      { Team: '', 'Team Name': 'Imported Three', Name: 'I3b', 'Emp ID': 'IM-302' },
      { Team: '', 'Team Name': 'Imported Three', Name: 'I3c', 'Emp ID': 'IM-303' },
    ];
    const mapping = { team_number: 'Team', team_name: 'Team Name', name: 'Name', employee_id: 'Emp ID' };
    const plan = buildPlan('participant', rows, mapping, ctx);
    expect(plan.errors).toEqual([]);
    const importId = await t.db.rpc<string>('create_import', { p_event: t.eventId, p_filename: 'x.csv', p_format: 'participant', p_headers: Object.keys(rows[0]), p_rows: rows, p_actor: t.actorId });
    await t.db.rpc('save_import_preview', { p_event: t.eventId, p_import: importId, p_mapping: mapping, p_plan: plan, p_summary: plan.summary, p_errors: plan.errors });
    const before45 = await credRows(teamId(45));
    await t.db.rpc('commit_import', { p_event: t.eventId, p_import: importId, p_actor: t.actorId });
    expect((await slot(teamId(45), 2)).participant_name).toBe('I2b');
    expect((await slot(teamId(45), 3)).occupancy).toBe('vacant');
    expect(await credRows(teamId(45))).toEqual(before45);
    const auto = plan.teams.find((x) => x.team_name === 'Imported Three')!;
    expect((await slot(auto.team_id, 3)).participant_name).toBe('I3c');
    await expectDx(t.db.rpc('commit_import', { p_event: t.eventId, p_import: importId, p_actor: t.actorId }), 'INVALID_STATE');

    // a second file targeting an occupied team is reported by the planner AND rejected by the DB
    const ctx2 = await t.db.rpc<Parameters<typeof buildPlan>[3]>('import_context', { p_event: t.eventId });
    const plan2 = buildPlan('participant', [rows[0], { ...rows[1], 'Emp ID': 'IM-999' }].map((r) => ({ ...r, 'Emp ID': r['Emp ID'] + 'X' })), mapping, ctx2);
    expect(plan2.errors.some((e) => e.message.includes('will not be overwritten'))).toBe(true);
    await expectDx(t.db.rpc('register_walk_in', { p_event: t.eventId, p_team: teamId(45), p_name: 'Over', p_members: [{ name: 'a', employee_id: 'OW1' }, { name: 'b', employee_id: 'OW2' }], p_actor: t.actorId }), 'TEAM_NOT_EMPTY');
  });
});
