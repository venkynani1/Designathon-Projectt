import { route, json, body } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { authorizePrivileged } from '@/lib/auth/roles';
import { db } from '@/lib/supabase/server';
import { currentEvent } from '@/lib/event';
import { walkInSchema } from '@/lib/validation';

/** Registers 2–4 walk-in participants into an unused pre-generated team (P1..Pn), keeping every existing PIN. */
export const POST = route(async (req) => {
  const admin = await requireAdmin({ role: 'registrar' });
  const input = await body(req, walkInSchema);
  const ev = await currentEvent(db());
  return json(await db().rpc('register_walk_in', {
    p_event: ev.id, p_team: input.team_id, p_name: input.team_name, p_members: input.members, p_actor: admin.user_id,
    p_privileged: authorizePrivileged(admin, input.privileged), p_reason: input.reason ?? null,
  }));
});
