import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';
import { hashPassword, verifyPassword } from '@/lib/crypto/passwords';
import { hashToken, newSessionToken } from '@/lib/crypto/tokens';

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => t?.close());

describe('built-in admin accounts', () => {
  it('stores only an Argon2id hash and verifies the password', async () => {
    const h = await hashPassword('correct horse battery');
    await t.db.rpc('upsert_admin_user', { p_email: 'Organizer@Corp.Example', p_display_name: 'Org', p_role: 'admin', p_can_issue: true, p_password_hash: h });
    const rec = await t.db.rpc<{ user_id: string; password_hash: string; is_active: boolean }>('admin_login_lookup', { p_email: 'organizer@corp.example ' });
    expect(rec.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(rec.password_hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(rec.password_hash, 'wrong password!!')).toBe(false);
    expect(await verifyPassword(null, 'anything at all')).toBe(false);
    await expect(hashPassword('short')).rejects.toThrow();
    await expect(t.sql(`update admin_users set password_hash = 'plaintext' where email = 'organizer@corp.example'`)).rejects.toThrow();
  });

  it('sessions resolve to the admin, and are revoked by logout and by password reset', async () => {
    const rec = await t.db.rpc<{ user_id: string }>('admin_login_lookup', { p_email: 'organizer@corp.example' });
    const token = newSessionToken();
    await t.db.rpc('create_admin_session', { p_user: rec.user_id, p_token_hash: hashToken(token), p_ttl_minutes: 60, p_ip: '1.2.3.4', p_ua: 'test' });
    const me = await t.db.rpc<{ email: string; role: string; can_issue_credentials: boolean }>('resolve_admin_session', { p_token_hash: hashToken(token) });
    expect(me).toMatchObject({ email: 'organizer@corp.example', role: 'admin', can_issue_credentials: true });
    expect(JSON.stringify(me)).not.toContain('argon2');
    await t.db.rpc('revoke_admin_session', { p_token_hash: hashToken(token) });
    expect(await t.db.rpc('resolve_admin_session', { p_token_hash: hashToken(token) })).toBeNull();

    const t2 = newSessionToken();
    await t.db.rpc('create_admin_session', { p_user: rec.user_id, p_token_hash: hashToken(t2), p_ttl_minutes: 60, p_ip: '1.2.3.4', p_ua: 'test' });
    await t.db.rpc('upsert_admin_user', { p_email: 'organizer@corp.example', p_display_name: null, p_role: 'admin', p_can_issue: null, p_password_hash: await hashPassword('a brand new password') });
    expect(await t.db.rpc('resolve_admin_session', { p_token_hash: hashToken(t2) })).toBeNull();
  });

  it('the server role works without BYPASSRLS (Neon-style hosting)', async () => {
    const r = await t.sql(`select rolbypassrls from pg_roles where rolname = 'service_role'`);
    expect(r.rows[0].rolbypassrls).toBe(false);
    expect((await t.db.rpc<unknown[]>('admin_list_teams', { p_event: t.eventId, p_q: '' }))).toEqual([]);
  });
});
