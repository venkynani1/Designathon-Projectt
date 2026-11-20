import ExcelJS from 'exceljs';
import { route, fileResponse } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { db } from '@/lib/server/db';
import { currentEvent } from '@/lib/event';

export const runtime = 'nodejs';

/** Offline registrations template with drop-downs for Veg/Non-veg and the current goodie names. */
export const GET = route(async () => {
  await requireAdmin({ role: 'viewer' });
  const ev = await currentEvent(db());
  const goodies = (await db().rpc<{ name: string; is_active: boolean; stock: number; reserved: number }[]>('admin_list_goodies', { p_event: ev.id }))
    .filter((g) => g.is_active);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Offline registrations', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Employee ID', key: 'id', width: 16 }, { header: 'Employee Name', key: 'name', width: 30 }, { header: 'Team Name', key: 'team', width: 24 },
    { header: 'Veg/Non-veg', key: 'meal', width: 14 }, { header: 'Goodie', key: 'goodie', width: 26 },
  ];
  ws.getColumn(1).numFmt = '@';
  ws.addRow({ id: '1000123', name: 'Asha Rao', team: 'Pixel Pioneers', meal: 'Veg', goodie: goodies[0]?.name ?? '' });
  const h = ws.getRow(1);
  h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4338CA' } };
  const list = wb.addWorksheet('Goodie names');
  list.columns = [{ header: 'Goodie', width: 28 }, { header: 'Left now', width: 10 }];
  goodies.forEach((g) => list.addRow([g.name, Math.max(g.stock - g.reserved, 0)]));
  list.getRow(1).font = { bold: true };
  for (let r = 2; r <= 1000; r++) {
    ws.getCell(`D${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: ['"Veg,Non-veg"'] };
    if (goodies.length) ws.getCell(`E${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`'Goodie names'!$A$2:$A$${goodies.length + 1}`] };
  }
  return fileResponse(Buffer.from(await wb.xlsx.writeBuffer()), 'offline-registrations-template.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});
