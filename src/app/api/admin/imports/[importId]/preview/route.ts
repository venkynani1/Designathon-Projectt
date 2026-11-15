import { route, json, body } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';
import { mappingSchema, uuid } from '@/lib/validation';
import { buildPlan, fieldsFor, type ImportContext, type ImportFormat } from '@/lib/import/plan';
import { DxError } from '@/lib/errors';

type Ctx = { params: Promise<{ importId: string }> };
interface StoredImport { id: string; format: ImportFormat; status: string; headers: string[]; raw_rows: Record<string, string>[] }

/** Step 2: apply the column mapping → validation, duplicate detection and the exact slot plan. Stored server-side. */
export const POST = route<Ctx>(async (req, { params }) => {
  await requireAdmin({ role: 'registrar' });
  const importId = uuid.parse((await params).importId);
  const { mapping } = await body(req, mappingSchema);
  const ev = await currentEvent(db());
  const imp = await db().rpc<StoredImport | null>('get_import', { p_event: ev.id, p_import: importId });
  if (!imp) throw new DxError('NOT_FOUND', 'Import not found');
  const allowed = new Set(fieldsFor(imp.format));
  for (const [k, v] of Object.entries(mapping)) {
    if (!allowed.has(k)) throw new DxError('INVALID_INPUT', `Unknown field ${k}`);
    if (v && !imp.headers.includes(v)) throw new DxError('INVALID_INPUT', `Column "${v}" is not in the file`);
  }
  const ctx = await db().rpc<ImportContext>('import_context', { p_event: ev.id });
  const plan = buildPlan(imp.format, imp.raw_rows, mapping, ctx);
  await db().rpc('save_import_preview', {
    p_event: ev.id, p_import: importId, p_mapping: mapping, p_plan: { teams: plan.teams }, p_summary: plan.summary, p_errors: plan.errors,
  });
  return json(plan);
});
