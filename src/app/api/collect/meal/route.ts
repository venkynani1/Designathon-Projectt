import { z } from 'zod';
import { route, json, body } from '@/lib/http';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';

/** Participant picks Veg/Non-veg on the spot (only if not chosen yet). */
export const POST = route(async (req) => {
  const { employee_id, meal } = await body(req, z.object({ employee_id: z.string().trim().min(2).max(40), meal: z.enum(['veg', 'nonveg']) }));
  const ev = await currentEvent(db());
  return json(await db().rpc('collect_set_meal', { p_event: ev.id, p_employee_id: employee_id, p_meal: meal }));
});
