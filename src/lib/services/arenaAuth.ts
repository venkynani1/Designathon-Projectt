import type { Db } from '../db';
import { DxError } from '../errors';
import { verifyPin } from '../crypto/pins';
import { hashToken, newSessionToken } from '../crypto/tokens';
import { enforceRateLimit, participantLoginRules, recordAttempt, teamLoginRules } from '../rateLimit';
import { normalizeEmployeeId } from '../normalize';

export const SESSION_TTL_MINUTES = { team: 12 * 60, participant: 6 * 60 } as const;

interface TeamLogin {
  team_id: string; team_number: number; name: string | null; status: string;
  credential_id: string | null; credential_status: string | null; pin_hash: string | null;
}
interface ParticipantLogin {
  slot_id: string; team_id: string; identity_id: string; name: string; slot_number: number; goodies_eligible: boolean;
  team_status: string; credential_id: string | null; credential_status: string | null; pin_hash: string | null;
}

const INVALID_TEAM = 'Team number or Team PIN is incorrect';
const INVALID_PARTICIPANT = 'Employee ID or personal PIN is incorrect';
const WITHDRAWN = 'This PIN has been withdrawn for security reasons. Please visit the registration desk.';

export async function authenticateTeam(db: Db, a: { eventId: string; teamNumber: number; pin: string; ip: string }) {
  if (!Number.isInteger(a.teamNumber) || a.teamNumber < 1 || a.teamNumber > 9999) throw new DxError('INVALID_CREDENTIALS', INVALID_TEAM);
  const rules = teamLoginRules(a.eventId, a.teamNumber, a.ip);
  await enforceRateLimit(db, rules);
  const rec = await db.rpc<TeamLogin | null>('get_team_login', { p_event: a.eventId, p_team_number: a.teamNumber });
  const ok = await verifyPin(rec?.pin_hash ?? null, a.pin); // always runs Argon2 (timing-safe for unknown teams)
  if (!ok || !rec?.credential_id) {
    await recordAttempt(db, rules, false);
    throw new DxError('INVALID_CREDENTIALS', INVALID_TEAM);
  }
  await recordAttempt(db, rules, true);
  if (rec.credential_status !== 'active') throw new DxError('CREDENTIAL_WITHDRAWN', WITHDRAWN);
  if (rec.status !== 'registered') {
    throw new DxError('TEAM_NOT_ELIGIBLE', 'Your team needs 2–4 registered participants. Please visit the registration desk.');
  }
  return { teamId: rec.team_id, credentialId: rec.credential_id };
}

export async function authenticateParticipant(db: Db, a: { eventId: string; employeeId: string; pin: string; ip: string }) {
  const emp = normalizeEmployeeId(a.employeeId);
  if (!emp || emp.length > 32) throw new DxError('INVALID_CREDENTIALS', INVALID_PARTICIPANT);
  const rules = participantLoginRules(a.eventId, emp, a.ip);
  await enforceRateLimit(db, rules);
  // Verifies: employee exists, is currently registered, occupies a slot, and the PIN belongs to THAT slot.
  const rec = await db.rpc<ParticipantLogin | null>('get_participant_login', { p_event: a.eventId, p_employee_id: emp });
  const ok = await verifyPin(rec?.pin_hash ?? null, a.pin);
  if (!ok || !rec?.credential_id) {
    await recordAttempt(db, rules, false);
    throw new DxError('INVALID_CREDENTIALS', INVALID_PARTICIPANT);
  }
  await recordAttempt(db, rules, true);
  if (rec.credential_status !== 'active') throw new DxError('CREDENTIAL_WITHDRAWN', WITHDRAWN);
  return { teamId: rec.team_id, slotId: rec.slot_id, identityId: rec.identity_id, credentialId: rec.credential_id };
}

export async function openArenaSession(
  db: Db,
  s: { eventId: string; kind: 'team' | 'participant'; teamId: string; slotId?: string; identityId?: string; credentialId: string; ip: string; userAgent: string },
): Promise<{ token: string; maxAgeSeconds: number }> {
  const token = newSessionToken();
  const ttl = SESSION_TTL_MINUTES[s.kind];
  await db.rpc('create_arena_session', {
    p_event: s.eventId, p_kind: s.kind, p_token_hash: hashToken(token), p_team: s.teamId,
    p_slot: s.slotId ?? null, p_identity: s.identityId ?? null, p_credential: s.credentialId,
    p_ttl_minutes: ttl, p_ip: s.ip, p_ua: s.userAgent,
  });
  return { token, maxAgeSeconds: ttl * 60 };
}

export interface ResolvedSession { session_id: string; event_id: string; team_id: string; slot_id: string | null; identity_id: string | null }

export function resolveArenaSession(db: Db, kind: 'team' | 'participant', token: string | undefined | null) {
  if (!token || token.length > 100) return Promise.resolve(null);
  return db.rpc<ResolvedSession | null>('resolve_arena_session', { p_token_hash: hashToken(token), p_kind: kind });
}
