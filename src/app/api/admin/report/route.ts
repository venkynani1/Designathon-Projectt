import { route, fileResponse } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/supabase/server';
import { currentEvent } from '@/lib/event';
import { buildTeamReport, type ReportRow } from '@/lib/reports/excel';

export const runtime = 'nodejs';

/** Ordinary Excel export — contains no credentials by construction. */
export const GET = route(async () => {
  await requireAdmin({ role: 'viewer' });
  const ev = await currentEvent(db());
  const rows = await db().rpc<ReportRow[]>('admin_report_rows', { p_event: ev.id });
  const buf = await buildTeamReport(ev.name, rows);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return fileResponse(buf, `${ev.code}-teams-${stamp}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});
