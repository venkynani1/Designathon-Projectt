import { route, json } from '@/lib/http';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { requireDesk } from '@/lib/auth/desk';
import { DxError } from '@/lib/errors';

export const dynamic = 'force-dynamic';

/** Shared live queue for all distributors. ?emp= looks up one person (for people without a phone). */
export const GET = route(async (req) => {
  const ev = await currentEvent(db());
  await requireDesk(db(), ev.id);
  const emp = req.nextUrl.searchParams.get('emp')?.trim();
  if (emp) {
    if (emp.length < 2 || emp.length > 40) throw new DxError('INVALID_INPUT', 'Enter a valid employee ID');
    // looking someone up at the desk = they're here: same as scanning (assigns the default goodie if they never responded)
    return json({ person: await db().rpc('collect_checkin', { p_event: ev.id, p_employee_id: emp }) });
  }
  return json(await db().rpc('desk_queue', { p_event: ev.id }));
});
