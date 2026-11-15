import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';

const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(pw: string): Promise<string> {
  if (pw.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  return hash(pw, ARGON2);
}

let dummy: Promise<string> | null = null;

/** Constant-work verification: always runs one Argon2 computation, even for unknown accounts. */
export async function verifyPassword(stored: string | null | undefined, pw: string): Promise<boolean> {
  dummy ??= hash(randomBytes(18).toString('base64'), ARGON2);
  const target = stored ?? (await dummy);
  const candidate = typeof pw === 'string' && pw.length > 0 && pw.length <= 200 ? pw : '\u0000';
  let ok = false;
  try {
    ok = await verify(target, candidate);
  } catch {
    ok = false;
  }
  return ok && !!stored && candidate === pw;
}
