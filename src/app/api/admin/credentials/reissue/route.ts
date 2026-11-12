import { route, json, body } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/supabase/server';
import { currentEvent } from '@/lib/event';
import { env } from '@/lib/env';
import { reissueSchema } from '@/lib/validation';
import { reissueCredentials } from '@/lib/services/provisioning';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Supervised reissue (superadmin + issuance permission). The ONLY path that changes a PIN. */
export const POST = route(async (req) => {
  const admin = await requireAdmin({ role: 'superadmin', issueCredentials: true });
  const { credential_ids, reason } = await body(req, reissueSchema);
  const ev = await currentEvent(db());
  return json(await reissueCredentials(db(), {
    eventId: ev.id, credentialIds: credential_ids, reason, actorId: admin.user_id, ttlHours: Math.min(ev.package_ttl_hours, 24),
    secrets: { pepper: env.pinPepper(), vaultKey: env.vaultKey() },
  }), 201);
});
