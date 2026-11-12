import { route, body, fileResponse } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/supabase/server';
import { currentEvent } from '@/lib/event';
import { env } from '@/lib/env';
import { uuid } from '@/lib/validation';
import { buildSlips } from '@/lib/services/slips';
import { renderSlipsPdf } from '@/lib/pdf/slips';
import { z } from 'zod';

type Ctx = { params: Promise<{ teamId: string }> };
export const runtime = 'nodejs';

/**
 * Single-team slip. with_pins=true requires credential-issuance permission and only
 * works while the issuing package is live; otherwise PIN fields read "REISSUE".
 * with_pins=false prints a registration slip with PINs masked (any registrar).
 */
export const POST = route<Ctx>(async (req, { params }) => {
  const { with_pins } = await body(req, z.object({ with_pins: z.boolean() }));
  const admin = await requireAdmin({ role: 'registrar', issueCredentials: with_pins });
  const teamId = uuid.parse((await params).teamId);
  const ev = await currentEvent(db());
  const slips = await buildSlips(db(), { eventId: ev.id, teamIds: [teamId], withPins: with_pins, vaultKey: with_pins ? env.vaultKey() : null });
  if (with_pins && slips.disclosedCredentialIds.length) {
    await db().rpc('mark_credentials_disclosed', {
      p_event: ev.id, p_credentials: slips.disclosedCredentialIds, p_actor: admin.user_id, p_context: { scope: 'team', team_id: teamId },
    });
  }
  const pdf = await renderSlipsPdf(ev, slips.teams);
  const n = String(slips.teams[0]?.team_number ?? 0).padStart(3, '0');
  return fileResponse(pdf, `team-${n}-${with_pins ? 'credential' : 'registration'}-slip.pdf`, 'application/pdf');
});
