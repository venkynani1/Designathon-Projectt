import { route } from '@/lib/http';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { requireDesk } from '@/lib/auth/desk';
import { attendanceFile } from '@/lib/reports/attendanceResponse';

export const runtime = 'nodejs';

/** Distributor's attendance download (team-wise present/absent, leftover goodies). */
export const GET = route(async () => {
  const ev = await currentEvent(db());
  const d = await requireDesk(db(), ev.id, { allowFinished: true });
  return attendanceFile(db(), ev, d.name);
});
