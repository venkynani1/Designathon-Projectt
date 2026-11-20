import ExcelJS from 'exceljs';
import { route, fileResponse } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';

export const runtime = 'nodejs';

/** Everyone in the participant list who hasn't responded yet — for a reminder email. */
export const GET = route(async () => {
  await requireAdmin({ role: 'viewer' });
  const ev = await currentEvent(db());
  const rep = await db().rpc<{ pending: { employee_id: string; name: string; email: string | null }[] }>('admin_survey_report', { p_event: ev.id });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('No response yet', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [{ header: 'Employee ID', width: 16 }, { header: 'Employee Name', width: 30 }];
  ws.getColumn(1).numFmt = '@';
  rep.pending.forEach((p) => ws.addRow([p.employee_id, p.name]));
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4338CA' } };
  const stamp = new Date().toISOString().slice(0, 10);
  return fileResponse(Buffer.from(await wb.xlsx.writeBuffer()), `reminder-list-${stamp}.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});
