import ExcelJS from 'exceljs';
import { teamLabel } from '../normalize';

export interface SurveyReport {
  choices: { employee_id: string; name: string; goodie: string; chosen_at: string; registered: boolean; registered_name: string | null;
             email: string | null; team_number: number | null; team_name: string | null }[];
  pending: { employee_id: string; name: string; email: string | null; team_number: number; team_name: string | null }[];
  goodies: { name: string; stock: number; reserved: number; is_active: boolean }[];
}

function sheet(wb: ExcelJS.Workbook, name: string, cols: [string, number][], rows: (string | number)[][], textCols: number[] = []) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map(([header, width]) => ({ header, width }));
  rows.forEach((r) => ws.addRow(r));
  const h = ws.getRow(1);
  h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4338CA' } };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  textCols.forEach((c) => (ws.getColumn(c).numFmt = '@'));
  return ws;
}

const ist = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export async function buildSurveyReport(eventName: string, d: SurveyReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Designathon X';
  wb.created = new Date();
  sheet(wb, 'Goodie choices',
    [['Employee ID', 16], ['Name', 28], ['Goodie', 24], ['Chosen at (IST)', 20], ['Registered?', 12], ['Email', 30], ['Team', 12], ['Team name', 24]],
    [...d.choices].reverse().map((c) => [c.employee_id, c.name, c.goodie, ist(c.chosen_at), c.registered ? 'Yes' : 'Not found',
      c.email ?? '', c.team_number ? teamLabel(c.team_number) : '', c.team_name ?? '']), [1]);
  sheet(wb, 'Totals per goodie', [['Goodie', 28], ['Quantity', 12], ['Chosen', 12], ['Left', 12], ['Visible', 10]],
    d.goodies.map((g) => [g.name, g.stock, g.reserved, Math.max(g.stock - g.reserved, 0), g.is_active ? 'Yes' : 'Hidden']));
  sheet(wb, 'Not chosen yet', [['Employee ID', 16], ['Name', 28], ['Email', 30], ['Team', 12], ['Team name', 24]],
    d.pending.map((p) => [p.employee_id, p.name, p.email ?? '', teamLabel(p.team_number), p.team_name ?? '']), [1]);
  const about = wb.addWorksheet('About');
  about.addRow([`${eventName} — goodies survey report`]);
  about.addRow([`Generated ${ist(new Date().toISOString())} IST`]);
  about.addRow([`${d.choices.length} responses · ${d.pending.length} registered participants have not chosen yet`]);
  about.addRow(['"Not found" = the employee ID typed in the survey does not match any registered participant.']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
