import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SealedBox {
  ciphertext: string;
  iv: string;
  auth_tag: string;
}

/**
 * AES-256-GCM with the package id bound as additional authenticated data, so a
 * ciphertext cannot be swapped into another package row.
 */
export function seal(payload: unknown, key: Buffer, aad: string): SealedBox {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), auth_tag: cipher.getAuthTag().toString('base64') };
}

export function open<T>(box: SealedBox, key: Buffer, aad: string): T {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(box.auth_tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(box.ciphertext, 'base64')), decipher.final()]);
  return JSON.parse(pt.toString('utf8')) as T;
}

export interface PackagePayload {
  v: 1;
  event_id: string;
  /** credential_record id -> plaintext PIN */
  credentials: Record<string, string>;
}
