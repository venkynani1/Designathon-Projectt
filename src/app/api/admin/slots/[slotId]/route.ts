import { route, json, body } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { authorizePrivileged } from '@/lib/auth/roles';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { slotActionSchema, uuid } from '@/lib/validation';

type Ctx = { params: Promise<{ slotId: string }> };

/**
 * update      — name/email corrections for the same employee (credential untouched)
 * replace     — different employee (or corrected employee ID); reason required; old reservation stays with old person
 * remove      — slot becomes vacant; credential + history kept; disclosed PIN => flagged compromised
 * eligibility — goodies eligibility toggle
 */
export const POST = route<Ctx>(async (req, { params }) => {
  const slotId = uuid.parse((await params).slotId);
  const input = await body(req, slotActionSchema);
  const admin = await requireAdmin({ role: input.action === 'eligibility' ? 'admin' : 'registrar' });
  const ev = await currentEvent(db());
  const d = db();
  switch (input.action) {
    case 'update':
      return json(await d.rpc('update_member_details', { p_event: ev.id, p_slot: slotId, p_name: input.name, p_email: input.email ?? null, p_actor: admin.user_id }));
    case 'replace':
      return json(await d.rpc('replace_member', {
        p_event: ev.id, p_slot: slotId, p_member: input.member, p_reason: input.reason, p_actor: admin.user_id,
        p_privileged: authorizePrivileged(admin, input.privileged),
      }));
    case 'remove':
      return json(await d.rpc('remove_member', {
        p_event: ev.id, p_slot: slotId, p_reason: input.reason, p_actor: admin.user_id, p_privileged: authorizePrivileged(admin, input.privileged),
      }));
    case 'eligibility':
      return json(await d.rpc('set_goodies_eligibility', { p_event: ev.id, p_slot: slotId, p_eligible: input.eligible, p_reason: input.reason, p_actor: admin.user_id }));
  }
});
