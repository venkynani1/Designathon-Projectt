import { route, json } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/supabase/server';
import { currentEvent } from '@/lib/event';
import { parseUpload } from '@/lib/import/parse';
import { suggestMapping, fieldsFor, type ImportFormat } from '@/lib/import/plan';
import { DxError } from '@/lib/errors';

export const runtime = 'nodejs';

export const GET = route(async () => {
  await requireAdmin({ role: 'registrar' });
  const ev = await currentEvent(db());
  return json({ imports: await db().rpc('list_imports', { p_event: ev.id }) });
});

/** Step 1: upload CSV/XLSX → stored server-side with headers and a suggested column mapping. */
export const POST = route(async (req) => {
  const admin = await requireAdmin({ role: 'registrar' });
  const form = await req.formData();
  const file = form.get('file');
  const format = form.get('format');
  if (!(file instanceof File)) throw new DxError('INVALID_INPUT', 'Attach a .csv or .xlsx file');
  if (format !== 'team' && format !== 'participant') throw new DxError('INVALID_INPUT', 'Choose team-based or participant-based format');
  const sheet = await parseUpload(await file.arrayBuffer(), file.name);
  const ev = await currentEvent(db());
  const id = await db().rpc<string>('create_import', {
    p_event: ev.id, p_filename: file.name.slice(0, 200), p_format: format, p_headers: sheet.headers, p_rows: sheet.rows, p_actor: admin.user_id,
  });
  return json({
    id, headers: sheet.headers, sample: sheet.rows.slice(0, 5), row_count: sheet.rows.length,
    fields: fieldsFor(format as ImportFormat), suggested_mapping: suggestMapping(sheet.headers, format as ImportFormat),
  }, 201);
});
