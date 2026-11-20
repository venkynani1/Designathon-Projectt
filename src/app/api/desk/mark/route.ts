import { z } from 'zod';
import { route, json, body } from '@/lib/http';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { requireDesk } from '@/lib/auth/desk';

/** Collected / Undo / Skip. Only the first "Collected" tap counts, even if two distributors tap at once. */
export const POST = route(async (req) => {
  const { employee_id, action } = await body(req, z.object({ employee_id: z.string().trim().min(2).max(40), action: z.enum(['collect', 'undo', 'skip', 'came']) }));
  const ev = await currentEvent(db());
  const desk = await requireDesk(db(), ev.id);
  return json(await db().rpc('desk_mark', { p_event: ev.id, p_employee_id: employee_id, p_action: action, p_by: desk.name }));
});
