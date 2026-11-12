import { createHmac, randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

export const PIN_LENGTH = 6;

// OWASP-recommended Argon2id parameters (19 MiB, t=2, p=1). Argon2id is the library default.
const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

/** Rejects PINs that humans guess first: 000000, 123456, 654321, 121212, 112233-style low-entropy. */
export function isWeakPin(pin: string): boolean {
  const d = pin.split('').map(Number);
  if (new Set(d).size <= 2) return true;
  const asc = d.every((x, i) => i === 0 || x === (d[i - 1] + 1) % 10);
  const desc = d.every((x, i) => i === 0 || x === (d[i - 1] + 9) % 10);
  return asc || desc;
}

/**
 * Cryptographically secure, uniformly random digits (crypto.randomInt uses the OS CSPRNG
 * with rejection sampling). PINs are never derived from team numbers or employee IDs.
 */
export function generatePin(length = PIN_LENGTH): string {
  for (;;) {
    let pin = '';
    for (let i = 0; i < length; i++) pin += String(randomInt(0, 10));
    if (!isWeakPin(pin)) return pin;
  }
}

/**
 * Keyed fingerprint used ONLY for the per-event uniqueness constraint.
 * The pepper lives in the environment, never in the database.
 */
export function pinFingerprint(pin: string, eventId: string, pepper: Buffer): string {
  return createHmac('sha256', pepper).update(`dx-pin:v1:${eventId}:${pin}`).digest('hex');
}

export function hashPin(pin: string): Promise<string> {
  return hash(pin, ARGON2);
}

let dummyHash: Promise<string> | null = null;
/** Hash used when the account doesn't exist, so response time doesn't reveal existence. */
function getDummyHash(): Promise<string> {
  dummyHash ??= hash(generatePin(), ARGON2);
  return dummyHash;
}

/**
 * Constant-time verification (argon2 verify compares digests in constant time).
 * Always performs one Argon2 computation, even for unknown subjects.
 */
export async function verifyPin(storedHash: string | null | undefined, pin: string): Promise<boolean> {
  const candidate = typeof pin === 'string' && /^\d{4,8}$/.test(pin) ? pin : '000000';
  const target = storedHash ?? (await getDummyHash());
  let ok = false;
  try {
    ok = await verify(target, candidate);
  } catch {
    ok = false;
  }
  return ok && !!storedHash && candidate === pin;
}

export interface MintedPin {
  pin: string;
  fingerprint: string;
}

/** Mints PINs whose fingerprints collide with nothing already used in the event (or in this batch). */
export function createPinMinter(eventId: string, pepper: Buffer, used: Set<string>) {
  return (): MintedPin => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const pin = generatePin();
      const fingerprint = pinFingerprint(pin, eventId, pepper);
      if (!used.has(fingerprint)) {
        used.add(fingerprint);
        return { pin, fingerprint };
      }
    }
    throw new Error('PIN space exhausted for this event');
  };
}
