import { DxError } from './errors';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new DxError('CONFIG', `Missing environment variable ${name}`);
  return v;
}

function key32(name: string): Buffer {
  const buf = Buffer.from(required(name), 'base64');
  if (buf.length !== 32) throw new DxError('CONFIG', `${name} must be 32 random bytes, base64-encoded`);
  return buf;
}

export const env = {
  eventCode: () => process.env.DX_EVENT_CODE ?? 'designathon-x',
  /** HMAC key for PIN fingerprints (uniqueness). Never stored in the database. */
  pinPepper: () => key32('DX_PIN_PEPPER'),
  /** AES-256-GCM key for temporary credential packages. Never stored in the database. */
  vaultKey: () => key32('DX_VAULT_KEY'),
  cronSecret: () => required('CRON_SECRET'),
  appUrl: () => process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
};
