import ExcelJS from 'exceljs';
import { teamLabel } from '../normalize';

export interface SurveyReport {
  choices: { employee_id: string; name: string; goodie: string; chosen_at: string; registered: boolean; registered_name: string | null;
             email: string | null; department: string | null; team_number: number | null; team_name: string | null }[];
  pending: { employee_id: string; name: string; email: string | null; department: string | null; team_number: number | null; team_name: string | null }[];
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

const MEAL: Record<string, string> = { veg: 'Veg', nonveg: 'Non-veg' };

export async function buildSurveyReport(eventName: string, d: SurveyReport, auto: Set<string> = new Set(),
  meals: { veg: number; nonveg: number; by_employee: Record<string, string> } = { veg: 0, nonveg: 0, by_employee: {} },
  att: { yes: number; no: number; by_employee: Record<string, boolean>; declined?: { employee_id: string; name: string; at: string; came_at?: string | null; marked_by?: string | null }[] } = { yes: 0, no: 0, by_employee: {} },
  collected: Record<string, { at: string; by: string | null }> = {}, via: Record<string, string> = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Gen AI Designathon';
  wb.created = new Date();
  sheet(wb, 'Goodie choices',
    [['Employee ID', 16], ['Name', 28], ['Goodie', 24], ['Meal', 10], ['Attending 27 Nov', 16], ['Chosen at (IST)', 20], ['In participant list?', 14], ['Email', 30], ['Department', 20], ['Team', 12], ['How', 16], ['Collected at (IST)', 20], ['Collected by', 16]],
    [...d.choices].reverse().map((c) => [c.employee_id, c.name, c.goodie, MEAL[meals.by_employee[c.employee_id]] ?? '',
      att.by_employee[c.employee_id] === undefined ? '' : att.by_employee[c.employee_id] ? 'Yes' : 'No', ist(c.chosen_at), c.registered ? 'Yes' : 'Not found',
      c.email ?? '', c.department ?? '', c.team_number ? teamLabel(c.team_number) : '', auto.has(c.employee_id) || via[c.employee_id] === 'autopick' ? 'Auto-assigned' : via[c.employee_id] === 'offline' ? 'Offline registration' : 'Chose in survey',
      collected[c.employee_id] ? ist(collected[c.employee_id].at) : 'Not collected', collected[c.employee_id]?.by ?? '']), [1]);
  sheet(wb, 'Totals per goodie', [['Goodie', 28], ['Quantity', 12], ['Chosen', 12], ['Left', 12], ['Visible', 10]],
    d.goodies.map((g) => [g.name, g.stock, g.reserved, Math.max(g.stock - g.reserved, 0), g.is_active ? 'Yes' : 'Hidden']));
  sheet(wb, 'Meal counts', [['Meal', 16], ['People', 12]], [['Veg', meals.veg], ['Non-veg', meals.nonveg], ['Total', meals.veg + meals.nonveg]]);
  sheet(wb, 'Attendance 27 Nov', [['Attending?', 16], ['People', 12]], [['Yes', att.yes], ['No', att.no], ['Total', att.yes + att.no]]);
  sheet(wb, 'Not attending', [['Employee ID', 16], ['Name', 28], ['Responded at (IST)', 20], ['Came anyway?', 14], ['Came at (IST)', 20]],
    (att.declined ?? []).map((d) => [d.employee_id, d.name, ist(d.at), d.came_at ? 'Yes — came' : 'No', d.came_at ? ist(d.came_at) : '']), [1]);
  sheet(wb, 'No response yet', [['Employee ID', 16], ['Name', 28], ['Email', 30], ['Department', 20], ['Team', 12]],
    d.pending.map((p) => [p.employee_id, p.name, p.email ?? '', p.department ?? '', p.team_number ? teamLabel(p.team_number) : '']), [1]);
  const about = wb.addWorksheet('About');
  about.addRow([`${eventName} — goodies survey report`]);
  about.addRow([`Generated ${ist(new Date().toISOString())} IST`]);
  about.addRow([`${d.choices.length} attending with a goodie · ${att.no} not attending · ${d.pending.length} no response yet`]);
  about.addRow(['"Not found" = the employee ID is not in the uploaded participant list or team registrations.']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
