import ExcelJS from 'exceljs';
import { route, fileResponse } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';

export const runtime = 'nodejs';

export const GET = route(async () => {
  await requireAdmin({ role: 'viewer' });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Teams', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [{ header: 'Employee ID', width: 16 }, { header: 'Employee Name', width: 30 }, { header: 'Team Name', width: 26 }];
  ws.getColumn(1).numFmt = '@';
  ws.addRow(['1000123', 'Asha Rao', 'Pixel Pioneers']);
  ws.addRow(['1000124', 'Ravi Kumar', 'Pixel Pioneers']);
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4338CA' } };
  return fileResponse(Buffer.from(await wb.xlsx.writeBuffer()), 'teams-template.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});
