import { route } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { attendanceFile } from '@/lib/reports/attendanceResponse';

export const runtime = 'nodejs';

export const GET = route(async () => {
  const admin = await requireAdmin({ role: 'viewer' });
  return attendanceFile(db(), await currentEvent(db()), admin.email);
});
