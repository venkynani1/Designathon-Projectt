import { route, fileResponse } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { buildTeamWiseReport, type TeamRow } from '@/lib/reports/teams';

export const runtime = 'nodejs';

/** "Generate team report": teams numbered alphabetically, members with response, goodie, meal, collection. */
export const GET = route(async () => {
  await requireAdmin({ role: 'viewer' });
  const ev = await currentEvent(db());
  const rows = await db().rpc<TeamRow[]>('admin_team_rows', { p_event: ev.id });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return fileResponse(await buildTeamWiseReport(ev.name, rows), `${ev.code}-team-report-${stamp}.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});
