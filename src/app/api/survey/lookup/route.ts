import { route, json } from '@/lib/http';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { DxError } from '@/lib/errors';

/** Public: employee ID → name (and whether they already chose). Exact match only. */
export const GET = route(async (req) => {
  const emp = (req.nextUrl.searchParams.get('emp') ?? '').trim();
  if (emp.length < 2 || emp.length > 40) throw new DxError('INVALID_INPUT', 'Enter your employee ID');
  const ev = await currentEvent(db());
  return json(await db().rpc('survey_lookup', { p_event: ev.id, p_employee_id: emp }));
});
