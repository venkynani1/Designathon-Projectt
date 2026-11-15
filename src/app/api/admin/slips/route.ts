import { route, body, fileResponse } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { env } from '@/lib/env';
import { slipsSchema } from '@/lib/validation';
import { buildSlips } from '@/lib/services/slips';
import { renderSlipsPdf } from '@/lib/pdf/slips';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Batch print (A4, 2 teams per page). Plaintext PINs require issuance permission and a live package. */
export const POST = route(async (req) => {
  const input = await body(req, slipsSchema);
  const admin = await requireAdmin({ role: input.with_pins ? 'admin' : 'registrar', issueCredentials: input.with_pins });
  const ev = await currentEvent(db());
  const slips = await buildSlips(db(), {
    eventId: ev.id, teamIds: input.team_ids?.length ? input.team_ids : null, withPins: input.with_pins,
    vaultKey: input.with_pins ? env.vaultKey() : null, includeUnregistered: input.include_unregistered ?? true,
  });
  if (input.with_pins && slips.disclosedCredentialIds.length) {
    await db().rpc('mark_credentials_disclosed', {
      p_event: ev.id, p_credentials: slips.disclosedCredentialIds, p_actor: admin.user_id,
      p_context: { scope: 'batch', teams: slips.teams.length, missing: slips.missing },
    });
  }
  const pdf = await renderSlipsPdf(ev, slips.teams);
  const res = fileResponse(pdf, `designathon-slips-${input.with_pins ? 'credentials' : 'registration'}.pdf`, 'application/pdf');
  res.headers.set('X-Missing-Pins', String(slips.missing));
  return res;
});
