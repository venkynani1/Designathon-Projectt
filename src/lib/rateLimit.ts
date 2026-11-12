import type { Db } from './db';
import { DxError } from './errors';

export interface LimitRule { key: string; max: number; windowSeconds: number }

/**
 * Two layers: a strict per-target limit (one team / one employee ID) and a generous
 * per-IP limit (corporate venues often share one NAT address).
 */
export const LIMITS = {
  perTarget: { max: 5, windowSeconds: 15 * 60 },
  perIp: { max: 60, windowSeconds: 15 * 60 },
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
