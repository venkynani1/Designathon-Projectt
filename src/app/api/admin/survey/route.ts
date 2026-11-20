import { route, json } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';

export const GET = route(async () => {
  await requireAdmin({ role: 'viewer' });
  const ev = await currentEvent(db());
  const [report, meals, attendance] = await Promise.all([db().rpc<Record<string, unknown>>('admin_survey_report', { p_event: ev.id }),
    db().rpc('admin_meal_summary', { p_event: ev.id }), db().rpc('admin_attendance_summary', { p_event: ev.id })]);
  return json({ ...report, meals, attendance });
});
