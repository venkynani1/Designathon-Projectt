import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createPinMinter, generatePin, hashPin, isWeakPin, pinFingerprint, verifyPin } from '@/lib/crypto/pins';
import { open, seal } from '@/lib/crypto/vault';
import { hashToken, newSessionToken } from '@/lib/crypto/tokens';

describe('PIN generation', () => {
  it('produces 6 random digits, rejecting weak patterns', () => {
    for (let i = 0; i < 2000; i++) {
      const p = generatePin();
      expect(p).toMatch(/^\d{6}$/);
      expect(isWeakPin(p)).toBe(false);
    }
    expect(isWeakPin('000000')).toBe(true);
    expect(isWeakPin('123456')).toBe(true);
    expect(isWeakPin('987654')).toBe(true);
    expect(isWeakPin('121212')).toBe(true);
    expect(isWeakPin('482913')).toBe(false);
  });

  it('is not derived from anything predictable (roughly uniform digits, no repeats in a 250 batch)', () => {
    const counts = new Array(10).fill(0);
    for (let i = 0; i < 5000; i++) for (const d of generatePin()) counts[Number(d)]++;
    for (const c of counts) expect(Math.abs(c - 3000)).toBeLessThan(400);
    const used = new Set<string>();
    const mint = createPinMinter('event-1', randomBytes(32), used);
    const batch = Array.from({ length: 250 }, () => mint().pin);
    expect(new Set(batch).size).toBe(250);
  });

  it('fingerprints are keyed and event-scoped', () => {
    const k = randomBytes(32);
    expect(pinFingerprint('482913', 'e1', k)).toBe(pinFingerprint('482913', 'e1', k));
    expect(pinFingerprint('482913', 'e1', k)).not.toBe(pinFingerprint('482913', 'e2', k));
    expect(pinFingerprint('482913', 'e1', k)).not.toBe(pinFingerprint('482913', 'e1', randomBytes(32)));
    expect(pinFingerprint('482913', 'e1', k)).toHaveLength(64);
  });

  it('hashes with Argon2id and verifies correctly', async () => {
    const h = await hashPin('482913');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPin(h, '482913')).toBe(true);
    expect(await verifyPin(h, '482914')).toBe(false);
    expect(await verifyPin(h, '')).toBe(false);
    expect(await verifyPin(null, '482913')).toBe(false);
    expect(await verifyPin('garbage', '482913')).toBe(false);
  });
});

describe('credential package vault', () => {
  it('round-trips and is bound to the package id', () => {
    const key = randomBytes(32);
    const box = seal({ v: 1, event_id: 'e', credentials: { a: '482913' } }, key, 'pkg-1');
    expect(box.ciphertext).not.toContain('482913');
    expect(open<{ credentials: Record<string, string> }>(box, key, 'pkg-1').credentials.a).toBe('482913');
    expect(() => open(box, key, 'pkg-2')).toThrow();
    expect(() => open(box, randomBytes(32), 'pkg-1')).toThrow();
    const tampered = { ...box, ciphertext: Buffer.from('x' + box.ciphertext).toString('base64') };
    expect(() => open(tampered, key, 'pkg-1')).toThrow();
  });
});

describe('session tokens', () => {
  it('are 256-bit random and stored only as SHA-256', () => {
    const a = newSessionToken();
    expect(a).not.toBe(newSessionToken());
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});
