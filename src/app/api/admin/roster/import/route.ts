import { route, json } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { parseUpload } from '@/lib/import/parse';
import { rosterFromSheet, rosterFromText, type RosterRow } from '@/lib/import/roster';
import { DxError } from '@/lib/errors';

export const runtime = 'nodejs';

/** Upload a CSV/XLSX file (form field "file") or pasted text (field "text"). replace=1 replaces the whole list. */
export const POST = route(async (req) => {
  const admin = await requireAdmin({ role: 'admin' });
  const form = await req.formData();
  const file = form.get('file');
  const text = form.get('text');
  let rows: RosterRow[];
  if (file instanceof File && file.size > 0) {
    if (!/\.(csv|xlsx)$/i.test(file.name)) throw new DxError('INVALID_INPUT', 'Upload a .csv or .xlsx file (Excel: File → Save As → .xlsx)');
    rows = rosterFromSheet(await parseUpload(await file.arrayBuffer(), file.name));
  } else if (typeof text === 'string' && text.trim()) {
    rows = rosterFromText(text);
  } else {
    throw new DxError('INVALID_INPUT', 'Choose a file or paste the list');
  }
  if (rows.length > 5000) throw new DxError('INVALID_INPUT', 'Up to 5000 people per upload');
  const ev = await currentEvent(db());
  return json(await db().rpc('admin_roster_import', { p_event: ev.id, p_rows: rows, p_replace: form.get('replace') === '1', p_actor: admin.user_id }));
});
