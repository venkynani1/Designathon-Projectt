import { randomUUID } from 'node:crypto';
import type { Db } from '../db';
import { DxError } from '../errors';
import { createPinMinter, hashPin } from '../crypto/pins';
import { seal, type PackagePayload } from '../crypto/vault';

export interface CredentialSecrets {
  pepper: Buffer;
  vaultKey: Buffer;
}

export const MAX_TEAMS_PER_BATCH = 100;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

/**
 * Creates `count` new numbered teams (continuing after the highest existing number),
 * each with a permanent team PIN and four permanent slot PINs. Plaintext PINs exist
 * only in memory and inside the AES-GCM sealed, time-limited credential package.
 */
export async function provisionTeams(
  db: Db,
  opts: { eventId: string; count: number; actorId: string; ttlHours: number; secrets: CredentialSecrets },
): Promise<{ package_id: string; teams: { team_id: string; team_number: number }[] }> {
  const { eventId, count, actorId, ttlHours, secrets } = opts;
  if (!Number.isInteger(count) || count < 1 || count > MAX_TEAMS_PER_BATCH) {
    throw new DxError('INVALID_INPUT', `Generate between 1 and ${MAX_TEAMS_PER_BATCH} teams per batch`);
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const used = new Set(await db.rpc<string[]>('event_pin_fingerprints', { p_event: eventId }));
    const mint = createPinMinter(eventId, secrets.pepper, used);
    const plain: Record<string, string> = {};
    const jobs: { credId: string; pin: string }[] = [];

    const teams = Array.from({ length: count }, () => {
      const team_id = randomUUID();
      const t = mint();
      const teamCredId = randomUUID();
      plain[teamCredId] = t.pin;
      jobs.push({ credId: teamCredId, pin: t.pin });
      const slots = [1, 2, 3, 4].map((slot_number) => {
        const s = mint();
        const credId = randomUUID();
        plain[credId] = s.pin;
        jobs.push({ credId, pin: s.pin });
        return { slot_id: randomUUID(), slot_number, credential: { id: credId, fingerprint: s.fingerprint, hash: '' } };
      });
      return { team_id, team_credential: { id: teamCredId, fingerprint: t.fingerprint, hash: '' }, slots };
    });

    const hashes = new Map<string, string>();
    await mapLimit(jobs, 8, async (j) => hashes.set(j.credId, await hashPin(j.pin)));
    for (const t of teams) {
      t.team_credential.hash = hashes.get(t.team_credential.id)!;
      for (const s of t.slots) s.credential.hash = hashes.get(s.credential.id)!;
    }

    const packageId = randomUUID();
    const payload: PackagePayload = { v: 1, event_id: eventId, credentials: plain };
    const box = seal(payload, secrets.vaultKey, packageId);
    const expires_at = new Date(Date.now() + ttlHours * 3600_000).toISOString();
    try {
      return await db.rpc('provision_teams', {
        p_event: eventId,
        p_teams: teams,
        p_package: { id: packageId, purpose: 'initial', expires_at, ...box },
        p_actor: actorId,
      });
    } catch (e) {
      if (e instanceof DxError && e.code === 'PIN_COLLISION' && attempt < 3) continue;
      throw e;
    }
  }
  throw new DxError('PIN_COLLISION', 'Could not generate unique credentials');
}

/**
 * Supervised reissue — the ONLY path that changes a PIN value. Used when the
 * original package expired (hashes cannot be reversed) or a credential was
 * compromised (e.g. disclosed to a replaced participant).
 */
export async function reissueCredentials(
  db: Db,
  opts: { eventId: string; credentialIds: string[]; reason: string; actorId: string; ttlHours: number; secrets: CredentialSecrets },
): Promise<{ package_id: string; reissued: { old: string; new: string; version: number }[] }> {
  const { eventId, credentialIds, reason, actorId, ttlHours, secrets } = opts;
  const ids = [...new Set(credentialIds)];
  if (ids.length === 0 || ids.length > 500) throw new DxError('INVALID_INPUT', 'Select 1–500 credentials to reissue');
  if ((reason ?? '').trim().length < 10) throw new DxError('REASON_REQUIRED', 'A reason of at least 10 characters is required');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const used = new Set(await db.rpc<string[]>('event_pin_fingerprints', { p_event: eventId }));
    const mint = createPinMinter(eventId, secrets.pepper, used);
    const plain: Record<string, string> = {};
    const items = await Promise.all(
      ids.map(async (old) => {
        const m = mint();
        const id = randomUUID();
        plain[id] = m.pin;
        return { old_credential_id: old, new: { id, fingerprint: m.fingerprint, hash: await hashPin(m.pin) } };
      }),
    );
    const packageId = randomUUID();
    const box = seal({ v: 1, event_id: eventId, credentials: plain } satisfies PackagePayload, secrets.vaultKey, packageId);
    const expires_at = new Date(Date.now() + ttlHours * 3600_000).toISOString();
    try {
      return await db.rpc('reissue_credentials', {
        p_event: eventId,
        p_items: items,
        p_package: { id: packageId, expires_at, ...box },
        p_reason: reason,
        p_actor: actorId,
      });
    } catch (e) {
      if (e instanceof DxError && e.code === 'PIN_COLLISION' && attempt < 3) continue;
      throw e;
    }
  }
  throw new DxError('PIN_COLLISION', 'Could not generate unique credentials');
}
