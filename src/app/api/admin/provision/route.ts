import { route, json, body } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { env } from '@/lib/env';
import { provisionSchema } from '@/lib/validation';
import { provisionTeams } from '@/lib/services/provisioning';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Generate the first batch (e.g. Team 001–050) or extend capacity (051, 052, …). Numbers are never reused. */
export const POST = route(async (req) => {
  const admin = await requireAdmin({ role: 'admin', issueCredentials: true });
  const { count } = await body(req, provisionSchema);
  const ev = await currentEvent(db(), true);
  const res = await provisionTeams(db(), {
    eventId: ev.id, count, actorId: admin.user_id, ttlHours: ev.package_ttl_hours,
    secrets: { pepper: env.pinPepper(), vaultKey: env.vaultKey() },
  });
  return json(res, 201);
});
