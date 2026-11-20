import ExcelJS from 'exceljs';
import { route, fileResponse } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';

export const runtime = 'nodejs';

/** Excel template for the goodies participant list: Employee ID + Employee Name only. */
export const GET = route(async () => {
  await requireAdmin({ role: 'viewer' });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Participants', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [{ header: 'Employee ID', key: 'id', width: 18 }, { header: 'Employee Name', key: 'name', width: 32 }];
  ws.getColumn(1).numFmt = '@'; // keep IDs as text (no lost leading zeros)
  ws.addRow({ id: 'EMP1001', name: 'Asha Rao' });
  ws.addRow({ id: 'EMP1002', name: 'Ravi Kumar' });
  const h = ws.getRow(1);
  h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4338CA' } };
  return fileResponse(Buffer.from(await wb.xlsx.writeBuffer()), 'participants-template.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});
