import { route, fileResponse } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { buildSurveyReport, type SurveyReport } from '@/lib/reports/survey';

export const runtime = 'nodejs';

export const GET = route(async () => {
  await requireAdmin({ role: 'viewer' });
  const ev = await currentEvent(db());
  const data = await db().rpc<SurveyReport>('admin_survey_report', { p_event: ev.id });
  const auto = await db().rpc<{ employee_id: string; goodie: string | null }[]>('admin_autopick_list', { p_event: ev.id });
  const autoIds = new Set(auto.filter((a) => a.goodie).map((a) => a.employee_id));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return fileResponse(await buildSurveyReport(ev.name, data, autoIds), `${ev.code}-goodies-${stamp}.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});
