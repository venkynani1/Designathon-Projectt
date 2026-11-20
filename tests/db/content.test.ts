import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, secrets, type TestDb } from './harness';
import { provisionTeams } from '@/lib/services/provisioning';
import { DxError } from '@/lib/errors';

let t: TestDb;
const dx = (code: string) => (e: unknown) => e instanceof DxError && e.code === code;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => t?.close());

describe('organizer-managed problem statements', () => {
  it('creates, edits, hides, protects capacity and blocks deleting picked problems', async () => {
    const up = (args: Record<string, unknown>) => t.db.rpc<{ id: string }>('admin_upsert_problem', {
      p_event: t.eventId, p_id: null, p_code: 'ps-01', p_title: 'Inclusive onboarding', p_summary: null, p_capacity: 1,
      p_document_url: null, p_is_active: true, p_sort_order: null, p_actor: t.actorId, ...args,
    });
    const { id } = await up({});
    await expect(up({ p_code: 'PS-01' })).rejects.toSatisfy(dx('INVALID_INPUT')); // duplicate code
    await expect(up({ p_code: 'PS-02', p_document_url: 'http://insecure' })).rejects.toSatisfy(dx('INVALID_INPUT'));
    const list = await t.db.rpc<{ code: string; taken: number }[]>('admin_list_problems', { p_event: t.eventId });
    expect(list[0]).toMatchObject({ code: 'PS-01', taken: 0 });

    // a team locks it
    const prov = await provisionTeams(t.db, { eventId: t.eventId, count: 1, actorId: t.actorId, ttlHours: 1, secrets });
    await t.db.rpc('register_walk_in', { p_event: t.eventId, p_team: prov.teams[0].team_id, p_name: 'Locker', p_members: [{ name: 'A', employee_id: 'A1' }, { name: 'B', employee_id: 'B1' }], p_actor: t.actorId });
    await t.db.rpc('set_event_flags', { p_event: t.eventId, p_flags: { problems_open: true }, p_actor: t.actorId });
    await t.db.rpc('lock_problem', { p_team: prov.teams[0].team_id, p_problem: id, p_session: null });

    await expect(up({ p_id: id, p_capacity: 0 })).rejects.toSatisfy(dx('INVALID_INPUT'));
    await up({ p_id: id, p_capacity: 3, p_title: 'Inclusive onboarding v2', p_document_url: 'https://drive.example/doc' });
    await expect(t.db.rpc('admin_delete_problem', { p_event: t.eventId, p_id: id, p_actor: t.actorId })).rejects.toSatisfy(dx('INVALID_STATE'));
    await up({ p_id: id, p_capacity: 3, p_title: 'Inclusive onboarding v2', p_is_active: false });
    const state = await t.db.rpc<{ problems: unknown[]; assignment: { title: string } }>('team_arena_state', { p_team: prov.teams[0].team_id });
    expect(state.problems).toHaveLength(0); // hidden from teams…
    expect(state.assignment.title).toBe('Inclusive onboarding v2'); // …but the locked team keeps its assignment

    const { id: spare } = await up({ p_code: 'PS-09', p_title: 'Spare' });
    await t.db.rpc('admin_delete_problem', { p_event: t.eventId, p_id: spare, p_actor: t.actorId });
  });
});

describe('organizer-managed goodies', () => {
  it('creates goodies with quantity, never lets quantity drop below reservations', async () => {
    const up = (args: Record<string, unknown>) => t.db.rpc<{ id: string }>('admin_upsert_goodie', {
      p_event: t.eventId, p_id: null, p_name: 'Hoodie', p_description: null, p_stock: 1, p_image_url: null,
      p_is_active: true, p_sort_order: null, p_actor: t.actorId, ...args,
    });
    const { id } = await up({ p_image_url: 'https://img.example/hoodie.png' });
    const ident = (await t.sql(`select current_identity_id id from participant_slots where occupancy = 'occupied' limit 1`)).rows[0].id;
    await t.db.rpc('set_event_flags', { p_event: t.eventId, p_flags: { goodies_open: true }, p_actor: t.actorId });
    const st = await t.db.rpc<{ goodies: { image_url: string }[] }>('reserve_goodie', { p_identity: ident, p_goodie: id, p_session: null });
    expect(st.goodies[0].image_url).toBe('https://img.example/hoodie.png');
    await expect(up({ p_id: id, p_stock: 0 })).rejects.toSatisfy(dx('INVALID_INPUT'));
    await up({ p_id: id, p_stock: 40 });
    const list = await t.db.rpc<{ stock: number; reserved: number }[]>('admin_list_goodies', { p_event: t.eventId });
    expect(list[0]).toMatchObject({ stock: 40, reserved: 1 });
    await expect(t.db.rpc('admin_delete_goodie', { p_event: t.eventId, p_id: id, p_actor: t.actorId })).rejects.toSatisfy(dx('INVALID_STATE'));
    await expect(up({ p_name: 'Bad', p_stock: -1 })).rejects.toSatisfy(dx('INVALID_INPUT'));
  });
});

describe('goodies survey (no PIN)', () => {
  it('one choice per employee, never oversells under concurrency, reports and resets', async () => {
    const mk = async (name: string, stock: number) => (await t.db.rpc<{ id: string }>('admin_upsert_goodie', {
      p_event: t.eventId, p_id: null, p_name: name, p_description: null, p_stock: stock, p_image_url: null,
      p_is_active: true, p_sort_order: null, p_actor: t.actorId,
    })).id;
    const cap = await mk('Cap', 3);
    const mug = await mk('Mug', 50);
    const submit = (emp: string, goodie: string, name = 'Some One') =>
      t.db.rpc<{ goodie: string; employee_id: string }>('survey_submit', { p_event: t.eventId, p_employee_id: emp, p_name: name, p_goodie: goodie, p_meal: 'veg', p_attending: true });

    await t.db.rpc('set_event_flags', { p_event: t.eventId, p_flags: { goodies_open: false }, p_actor: t.actorId });
    await expect(submit('S0001', cap)).rejects.toSatisfy(dx('ARENA_CLOSED'));
    await t.db.rpc('set_event_flags', { p_event: t.eventId, p_flags: { goodies_open: true }, p_actor: t.actorId });

    // 20 different people race for 3 caps → exactly 3 win
    const race = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => submit(`R${100 + i}`, cap)));
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(race.filter((r) => r.status === 'rejected').every((r) => dx('OUT_OF_STOCK')((r as PromiseRejectedResult).reason))).toBe(true);

    // the same person on 5 phones at once → exactly one choice
    const dup = await Promise.allSettled(Array.from({ length: 5 }, () => submit(' s 777 ', mug)));
    expect(dup.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await expect(submit('S777', mug)).rejects.toThrow(/already chosen: Mug/);

    await expect(submit('S8', mug, 'X')).rejects.toSatisfy(dx('INVALID_INPUT'));
    const feed = await t.db.rpc<{ open: boolean; goodies: { name: string; left: number }[] }>('survey_feed', { p_event: t.eventId });
    expect(feed.open).toBe(true);
    expect(feed.goodies.find((g) => g.name === 'Cap')?.left).toBe(0);
    expect(feed.goodies.find((g) => g.name === 'Mug')?.left).toBe(49);

    // quantity floor and delete protection include survey choices
    await expect(t.db.rpc('admin_upsert_goodie', { p_event: t.eventId, p_id: cap, p_name: 'Cap', p_description: null, p_stock: 2, p_image_url: null, p_is_active: true, p_sort_order: null, p_actor: t.actorId }))
      .rejects.toSatisfy(dx('INVALID_INPUT'));
    await expect(t.db.rpc('admin_delete_goodie', { p_event: t.eventId, p_id: mug, p_actor: t.actorId })).rejects.toSatisfy(dx('INVALID_STATE'));

    const rep = await t.db.rpc<{ choices: { employee_id: string; registered: boolean }[]; pending: unknown[] }>('admin_survey_report', { p_event: t.eventId });
    expect(rep.choices.map((c) => c.employee_id)).toContain('S777');
    expect(rep.choices.find((c) => c.employee_id === 'S777')?.registered).toBe(false);

    await t.db.rpc('admin_reset_choice', { p_event: t.eventId, p_employee_id: 's777', p_actor: t.actorId });
    expect((await submit('S777', mug)).goodie).toBe('Mug');

    // photos
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await t.db.rpc('admin_set_goodie_image', { p_event: t.eventId, p_id: mug, p_mime: 'image/png', p_data_b64: png.toString('base64'), p_actor: t.actorId });
    const img = await t.db.rpc<{ mime: string; data: string }>('get_goodie_image', { p_goodie: mug });
    expect(Buffer.from(img.data, 'base64').equals(png)).toBe(true);
    const f2 = await t.db.rpc<{ goodies: { name: string; image: string }[] }>('survey_feed', { p_event: t.eventId });
    expect(f2.goodies.find((g) => g.name === 'Mug')?.image).toBe(`/api/survey/image/${mug}?v=1`);
  });
});

describe('goodies participant list', () => {
  it('imports, looks up names, restricts to the list and reports who is pending', async () => {
    const res = await t.db.rpc<{ added: number; updated: number; skipped: { problem: string }[]; total: number }>('admin_roster_import', {
      p_event: t.eventId, p_replace: true, p_actor: t.actorId,
      p_rows: [
        { employee_id: 'l 100', name: '  Asha   Rao ', email: 'ASHA@x.com', department: 'Design' },
        { employee_id: 'L101', name: 'Ravi Kumar' },
        { employee_id: 'L101', name: 'Dup' },
        { employee_id: '!', name: 'Bad Id' },
        { employee_id: 'L102', name: '' },
      ],
    });
    expect(res).toMatchObject({ added: 2, updated: 0, total: 2 });
    expect(res.skipped.map((s) => s.problem)).toEqual(['duplicate in file (first one kept)', 'invalid employee ID', 'missing name']);

    const look = await t.db.rpc<{ found: boolean; name: string; list_required: boolean; chosen: string | null }>('survey_lookup', { p_event: t.eventId, p_employee_id: 'l100' });
    expect(look).toMatchObject({ found: true, name: 'Asha Rao', list_required: true, chosen: null });
    expect((await t.db.rpc<{ found: boolean }>('survey_lookup', { p_event: t.eventId, p_employee_id: 'NOPE1' })).found).toBe(false);

    const g = (await t.db.rpc<{ id: string }>('admin_upsert_goodie', {
      p_event: t.eventId, p_id: null, p_name: 'Sticker pack', p_description: null, p_stock: 10, p_image_url: null,
      p_is_active: true, p_sort_order: null, p_actor: t.actorId,
    })).id;
    await t.db.rpc('set_event_flags', { p_event: t.eventId, p_flags: { goodies_open: true }, p_actor: t.actorId });
    await expect(t.db.rpc('survey_submit', { p_event: t.eventId, p_employee_id: 'NOPE1', p_name: 'Some One', p_goodie: g, p_meal: 'veg', p_attending: true })).rejects.toSatisfy(dx('NOT_FOUND'));
    // typed name is ignored — the list's name wins
    const ok = await t.db.rpc<{ name: string }>('survey_submit', { p_event: t.eventId, p_employee_id: 'L100', p_name: 'x', p_goodie: g, p_meal: 'veg', p_attending: true });
    expect(ok.name).toBe('Asha Rao');
    const feed = await t.db.rpc<{ recent: { who: string; goodie: string }[]; list_required: boolean }>('survey_feed', { p_event: t.eventId });
    expect(feed.recent[0]).toMatchObject({ who: 'Asha', goodie: 'Sticker pack' });
    expect(feed.list_required).toBe(true);

    const rep = await t.db.rpc<{ pending: { employee_id: string }[]; roster_size: number }>('admin_survey_report', { p_event: t.eventId });
    expect(rep.roster_size).toBe(2);
    expect(rep.pending.map((p) => p.employee_id)).toContain('L101');
    expect(rep.pending.map((p) => p.employee_id)).not.toContain('L100');

    // edit: can't change the ID of someone who already chose; name fix flows into the report
    await expect(t.db.rpc('admin_roster_save', { p_event: t.eventId, p_employee_id: 'L999', p_name: 'Asha Rao', p_email: null, p_department: null, p_original: 'L100', p_actor: t.actorId }))
      .rejects.toSatisfy(dx('INVALID_STATE'));
    await t.db.rpc('admin_roster_save', { p_event: t.eventId, p_employee_id: 'L100', p_name: 'Asha R. Rao', p_email: null, p_department: null, p_original: 'L100', p_actor: t.actorId });
    const list = await t.db.rpc<{ employee_id: string; name: string; goodie: string | null }[]>('admin_roster_list', { p_event: t.eventId });
    expect(list.find((p) => p.employee_id === 'L100')).toMatchObject({ name: 'Asha R. Rao', goodie: 'Sticker pack' });

    expect(await t.db.rpc('admin_roster_clear', { p_event: t.eventId, p_actor: t.actorId })).toBe(2);
    expect((await t.db.rpc<{ list_required: boolean }>('survey_lookup', { p_event: t.eventId, p_employee_id: 'X1' })).list_required).toBe(false);
  });
});

describe('auto-picks', () => {
  it('assigns everyone on the list at the first public visit after opening, before any survey pick, and logs it', async () => {
    const mk = async (name: string, stock: number) => (await t.db.rpc<{ id: string }>('admin_upsert_goodie', {
      p_event: t.eventId, p_id: null, p_name: name, p_description: null, p_stock: stock, p_image_url: null, p_is_active: true, p_sort_order: null, p_actor: t.actorId,
    })).id;
    const gold = await mk('Gold pen', 1);
    const tee = await mk('Tee', 5);
    await t.db.rpc('set_event_flags', { p_event: t.eventId, p_flags: { goodies_open: false }, p_actor: t.actorId });
    const a = await t.db.rpc<{ token: string }>('admin_autopick_save', { p_event: t.eventId, p_employee_id: 'ap1', p_name: 'Kiran Das', p_prefs: [gold, tee], p_meal: 'nonveg', p_attending: true, p_actor: t.actorId });
    await t.db.rpc('admin_autopick_save', { p_event: t.eventId, p_employee_id: 'AP2', p_name: 'Nila Sen', p_prefs: [gold, tee], p_meal: 'nonveg', p_attending: true, p_actor: t.actorId });

    expect(await t.db.rpc('autopick_run_pending', { p_event: t.eventId })).toBe(0); // closed: nothing happens
    await expect(t.db.rpc('autopick_claim', { p_token: a.token })).rejects.toSatisfy(dx('ARENA_CLOSED'));
    await t.db.rpc('set_event_flags', { p_event: t.eventId, p_flags: { goodies_open: true }, p_actor: t.actorId });

    // first outside pick (someone racing for the gold pen) — listed people are assigned first
    await t.db.rpc('admin_roster_import', { p_event: t.eventId, p_rows: [{ employee_id: 'OUT1', name: 'Out Sider' }], p_replace: false, p_actor: t.actorId });
    expect(await t.db.rpc('autopick_run_pending', { p_event: t.eventId })).toBe(2); // what the submit/feed/page routes do first
    await expect(t.db.rpc('survey_submit', { p_event: t.eventId, p_employee_id: 'OUT1', p_name: '', p_goodie: gold, p_meal: 'veg', p_attending: true })).rejects.toSatisfy(dx('OUT_OF_STOCK'));
    const list = await t.db.rpc<{ employee_id: string; goodie: string | null }[]>('admin_autopick_list', { p_event: t.eventId });
    expect(list.find((x) => x.employee_id === 'AP1')?.goodie).toBe('Gold pen');
    expect(list.find((x) => x.employee_id === 'AP2')?.goodie).toBe('Tee'); // fell back to 2nd preference
    expect(await t.db.rpc('autopick_run_pending', { p_event: t.eventId })).toBe(0); // idempotent
    expect((await t.db.rpc<{ goodie: string }>('autopick_claim', { p_token: a.token })).goodie).toBe('Gold pen');
    const feed = await t.db.rpc<{ goodies: { name: string; left: number }[] }>('survey_feed', { p_event: t.eventId });
    expect(feed.goodies.find((g) => g.name === 'Tee')?.left).toBe(4);
    const logged = await t.sql(`select count(*)::int n from audit_logs where action = 'goodie.auto_assigned'`);
    expect(logged.rows[0].n).toBe(2);
  });
});

describe('meal preference', () => {
  it('requires veg/non-veg with the goodie and counts it', async () => {
    const g = (await t.db.rpc<{ id: string }>('admin_upsert_goodie', {
      p_event: t.eventId, p_id: null, p_name: 'Meal test cap', p_description: null, p_stock: 5, p_image_url: null, p_is_active: true, p_sort_order: null, p_actor: t.actorId,
    })).id;
    await t.db.rpc('set_event_flags', { p_event: t.eventId, p_flags: { goodies_open: true }, p_actor: t.actorId });
    await t.db.rpc('admin_roster_import', { p_event: t.eventId, p_rows: [{ employee_id: 'MEAL1', name: 'Meal One' }, { employee_id: 'MEAL2', name: 'Meal Two' }], p_replace: false, p_actor: t.actorId });
    await expect(t.db.rpc('survey_submit', { p_event: t.eventId, p_employee_id: 'MEAL1', p_name: '', p_goodie: g, p_meal: 'fish', p_attending: true })).rejects.toSatisfy(dx('INVALID_INPUT'));
    expect((await t.db.rpc<{ meal: string }>('survey_submit', { p_event: t.eventId, p_employee_id: 'MEAL1', p_name: '', p_goodie: g, p_meal: 'veg', p_attending: true })).meal).toBe('veg');
    await t.db.rpc('survey_submit', { p_event: t.eventId, p_employee_id: 'MEAL2', p_name: '', p_goodie: g, p_meal: 'nonveg', p_attending: true });
    await expect(t.db.rpc('survey_submit', { p_event: t.eventId, p_employee_id: 'MEAL2', p_name: '', p_goodie: g, p_meal: 'veg', p_attending: true })).rejects.toSatisfy(dx('ALREADY_RESERVED'));
    const m = await t.db.rpc<{ by_employee: Record<string, string> }>('admin_meal_summary', { p_event: t.eventId });
    expect(m.by_employee).toMatchObject({ MEAL1: 'veg', MEAL2: 'nonveg', AP1: 'nonveg', AP2: 'nonveg' });
  });
});

describe('attendance on 27 Nov', () => {
  it('is required and counted', async () => {
    const g = (await t.db.rpc<{ id: string }>('admin_upsert_goodie', {
      p_event: t.eventId, p_id: null, p_name: 'Attend cap', p_description: null, p_stock: 5, p_image_url: null, p_is_active: true, p_sort_order: null, p_actor: t.actorId,
    })).id;
    await t.db.rpc('admin_roster_import', { p_event: t.eventId, p_rows: [{ employee_id: 'ATT1', name: 'Att One' }], p_replace: false, p_actor: t.actorId });
    await expect(t.db.rpc('survey_submit', { p_event: t.eventId, p_employee_id: 'ATT1', p_name: '', p_goodie: g, p_meal: 'veg', p_attending: null })).rejects.toSatisfy(dx('INVALID_INPUT'));
    expect((await t.db.rpc<{ attending: boolean }>('survey_submit', { p_event: t.eventId, p_employee_id: 'ATT1', p_name: '', p_goodie: g, p_meal: 'veg', p_attending: false })).attending).toBe(false);
    const a = await t.db.rpc<{ by_employee: Record<string, boolean> }>('admin_attendance_summary', { p_event: t.eventId });
    expect(a.by_employee).toMatchObject({ ATT1: false, AP1: true });
  });
});

describe('attendance first', () => {
  it('"No" records not attending with no goodie or meal; one response per person', async () => {
    const g = (await t.db.rpc<{ id: string }>('admin_upsert_goodie', {
      p_event: t.eventId, p_id: null, p_name: 'Decline test cap', p_description: null, p_stock: 2, p_image_url: null, p_is_active: true, p_sort_order: null, p_actor: t.actorId,
    })).id;
    await t.db.rpc('admin_roster_import', { p_event: t.eventId, p_rows: [{ employee_id: 'NO1', name: 'Nora One' }, { employee_id: 'YES1', name: 'Yash One' }], p_replace: false, p_actor: t.actorId });
    const r = await t.db.rpc<{ goodie: string | null; attending: boolean }>('survey_submit', { p_event: t.eventId, p_employee_id: 'NO1', p_name: '', p_goodie: null, p_meal: null, p_attending: false });
    expect(r).toMatchObject({ goodie: null, attending: false });
    // can't come back and take a goodie
    await expect(t.db.rpc('survey_submit', { p_event: t.eventId, p_employee_id: 'NO1', p_name: '', p_goodie: g, p_meal: 'veg', p_attending: true })).rejects.toSatisfy(dx('ALREADY_RESERVED'));
    // "Yes" still needs goodie + meal
    await expect(t.db.rpc('survey_submit', { p_event: t.eventId, p_employee_id: 'YES1', p_name: '', p_goodie: g, p_meal: null, p_attending: true })).rejects.toSatisfy(dx('INVALID_INPUT'));
    await t.db.rpc('survey_submit', { p_event: t.eventId, p_employee_id: 'YES1', p_name: '', p_goodie: g, p_meal: 'veg', p_attending: true });
    await expect(t.db.rpc('survey_submit', { p_event: t.eventId, p_employee_id: 'YES1', p_name: '', p_goodie: null, p_meal: null, p_attending: false })).rejects.toSatisfy(dx('ALREADY_RESERVED'));
    // stock untouched by the decline
    const feed = await t.db.rpc<{ goodies: { name: string; left: number }[] }>('survey_feed', { p_event: t.eventId });
    expect(feed.goodies.find((x) => x.name === 'Decline test cap')?.left).toBe(1);
    const look = await t.db.rpc<{ declined: boolean }>('survey_lookup', { p_event: t.eventId, p_employee_id: 'NO1' });
    expect(look.declined).toBe(true);
    const att = await t.db.rpc<{ by_employee: Record<string, boolean>; declined: { employee_id: string }[] }>('admin_attendance_summary', { p_event: t.eventId });
    expect(att.by_employee).toMatchObject({ NO1: false, YES1: true });
    const rep = await t.db.rpc<{ pending: { employee_id: string }[] }>('admin_survey_report', { p_event: t.eventId });
    expect(rep.pending.map((p) => p.employee_id)).not.toContain('NO1');
    await t.db.rpc('admin_reset_choice', { p_event: t.eventId, p_employee_id: 'NO1', p_actor: t.actorId });
    expect((await t.db.rpc<{ declined: boolean }>('survey_lookup', { p_event: t.eventId, p_employee_id: 'NO1' })).declined).toBe(false);
  });
});
