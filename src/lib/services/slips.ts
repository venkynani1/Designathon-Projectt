import type { Db } from '../db';
import { open, type PackagePayload } from '../crypto/vault';
import type { SlipTeam } from '../pdf/slips';

interface CredRef { id: string; status: 'active' | 'compromised' | 'revoked'; package_id: string | null; version: number }
interface SlipRow {
  team_id: string;
  team_number: number;
  team_name: string | null;
  registration_status: string;
  team_credential: CredRef | null;
  slots: { slot_number: number; participant_name: string | null; employee_id: string | null; credential: CredRef | null }[];
}

export type PinState = 'available' | 'reissue_required' | 'withheld';

/**
 * Assembles slip content. When `withPins` is set, plaintext PINs are recovered
 * ONLY from credential packages that are still inside their issuance window.
 * Anything else is reported as 'reissue_required' — PINs are never "recovered" from hashes.
 */
export async function buildSlips(
  db: Db,
  opts: { eventId: string; teamIds: string[] | null; withPins: boolean; vaultKey: Buffer | null; includeUnregistered?: boolean },
): Promise<{ teams: SlipTeam[]; disclosedCredentialIds: string[]; missing: number }> {
  const rows = await db.rpc<SlipRow[]>('slip_data', { p_event: opts.eventId, p_team_ids: opts.teamIds });
  const pins = new Map<string, string>();
  if (opts.withPins && opts.vaultKey) {
    const pkgIds = new Set<string>();
    for (const r of rows) {
      if (r.team_credential?.package_id) pkgIds.add(r.team_credential.package_id);
      for (const s of r.slots) if (s.credential?.package_id) pkgIds.add(s.credential.package_id);
    }
    if (pkgIds.size) {
      const secrets = await db.rpc<{ id: string; ciphertext: string; iv: string; auth_tag: string }[]>('package_secrets', {
        p_event: opts.eventId,
        p_packages: [...pkgIds],
      });
      for (const box of secrets) {
        const payload = open<PackagePayload>(box, opts.vaultKey, box.id);
        if (payload.event_id !== opts.eventId) continue;
        for (const [k, v] of Object.entries(payload.credentials)) pins.set(k, v);
      }
    }
  }
  const disclosed: string[] = [];
  let missing = 0;
  const resolve = (c: CredRef | null): { pin: string | null; state: PinState } => {
    if (!opts.withPins) return { pin: null, state: 'withheld' };
    if (!c || c.status !== 'active') {
      missing++;
      return { pin: null, state: 'reissue_required' };
    }
    const pin = pins.get(c.id);
    if (!pin) {
      missing++;
      return { pin: null, state: 'reissue_required' };
    }
    disclosed.push(c.id);
    return { pin, state: 'available' };
  };
  const teams: SlipTeam[] = rows
    .filter((r) => opts.includeUnregistered !== false || r.registration_status !== 'unregistered')
    .map((r) => {
      const t = resolve(r.team_credential);
      return {
        team_number: r.team_number,
        team_name: r.team_name,
        team_pin: t.pin,
        team_pin_state: t.state,
        members: r.slots.map((s) => {
          const p = resolve(s.credential);
          return { slot_number: s.slot_number, name: s.participant_name, employee_id: s.employee_id, pin: p.pin, pin_state: p.state };
        }),
      };
    });
  return { teams, disclosedCredentialIds: disclosed, missing };
}
