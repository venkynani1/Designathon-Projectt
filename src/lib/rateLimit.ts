import type { Db } from './db';
import { DxError } from './errors';

export interface LimitRule { key: string; max: number; windowSeconds: number }

/**
 * Two layers: a strict per-target limit (one team / one employee ID) and a generous
 * per-IP limit (corporate venues often share one NAT address).
 */
const envInt = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
};

/**
 * At an in-person event every phone on venue Wi-Fi shares ONE public IP, so the per-IP
 * ceiling must comfortably exceed the typos of ~1000 people. Brute-force protection comes
 * from the strict per-team / per-employee limit (5 wrong PINs per 15 min per target).
 */
export const LIMITS = {
  perTarget: { max: envInt('DX_RL_TARGET_MAX', 5), windowSeconds: 15 * 60 },
  perIp: { max: envInt('DX_RL_IP_MAX', 2000), windowSeconds: 15 * 60 },
};

export function teamLoginRules(eventId: string, teamNumber: number, ip: string): LimitRule[] {
  return [
    { key: `team:${eventId}:${teamNumber}`, ...LIMITS.perTarget },
    { key: `ip:${ip}:arena`, ...LIMITS.perIp },
  ];
}

export function participantLoginRules(eventId: string, employeeId: string, ip: string): LimitRule[] {
  return [
    { key: `emp:${eventId}:${employeeId}`, ...LIMITS.perTarget },
    { key: `ip:${ip}:arena`, ...LIMITS.perIp },
  ];
}

export async function enforceRateLimit(db: Db, rules: LimitRule[]): Promise<void> {
  const waits = await Promise.all(
    rules.map((r) => db.rpc<number>('rl_retry_after', { p_key: r.key, p_max: r.max, p_window_seconds: r.windowSeconds })),
  );
  const retryAfter = Math.max(0, ...waits.map(Number));
  if (retryAfter > 0) {
    throw new DxError('RATE_LIMITED', `Too many incorrect attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s) or visit the help desk.`, {
      retryAfter,
    });
  }
}

export async function recordAttempt(db: Db, rules: LimitRule[], success: boolean): Promise<void> {
  await db.rpc('rl_record', { p_keys: rules.map((r) => r.key), p_success: success });
}

/** Survey: generous per network (whole office may share one IP), tight per employee ID. */
export function surveyRules(eventId: string, employeeId: string, ip: string): LimitRule[] {
  return [
    { key: `survey-emp:${eventId}:${employeeId.toUpperCase().replace(/\s/g, '')}`, max: 10, windowSeconds: 15 * 60 },
    { key: `ip:${ip}:survey`, ...LIMITS.perIp },
  ];
}
