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
      t.db.rpc<{ goodie: string; employee_id: string }>('survey_submit', { p_event: t.eventId, p_employee_id: emp, p_name: name, p_goodie: goodie });

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
