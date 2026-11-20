import { route, json } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { parseUpload } from '@/lib/import/parse';
import { teamsFromSheet } from '@/lib/import/roster';
import { DxError } from '@/lib/errors';

export const runtime = 'nodejs';

/** Team file: Employee ID, Employee Name, Team Name. */
export const POST = route(async (req) => {
  const admin = await requireAdmin({ role: 'admin' });
  const file = (await req.formData()).get('file');
  if (!(file instanceof File) || file.size === 0) throw new DxError('INVALID_INPUT', 'Choose the Excel file');
  if (!/\.(xlsx|csv)$/i.test(file.name)) throw new DxError('INVALID_INPUT', 'Upload a .xlsx (or .csv) file');
  const rows = teamsFromSheet(await parseUpload(await file.arrayBuffer(), file.name));
  const ev = await currentEvent(db());
  return json(await db().rpc('admin_team_import', { p_event: ev.id, p_rows: rows, p_actor: admin.user_id }));
});
