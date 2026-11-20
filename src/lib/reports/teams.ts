import ExcelJS from 'exceljs';

export interface TeamRow {
  group: number | null; team: string; employee_id: string; name: string;
  response: 'Attending' | 'Not attending' | 'No response';
  goodie: string | null; meal: 'veg' | 'nonveg' | null; collected_at: string | null; collected_by: string | null; came_at: string | null;
}
export interface Leftover { name: string; stock: number; chosen: number; collected: number }

const BRAND = 'FF4338CA';
const ist = (iso: string | null) => iso
  ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const MEAL: Record<string, string> = { veg: 'Veg', nonveg: 'Non-veg' };
const groupLabel = (r: TeamRow) => (r.group ? `Group ${r.group}` : 'Unassigned');

function header(ws: ExcelJS.Worksheet, cols: [string, number][]) {
  ws.columns = cols.map(([header, width]) => ({ header, width }));
  const h = ws.getRow(1);
  h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

function byTeam(rows: TeamRow[]) {
  const m = new Map<string, TeamRow[]>();
  for (const r of rows) { const k = `${r.group ?? 9e9}|${r.team}`; m.set(k, [...(m.get(k) ?? []), r]); }
  return [...m.values()];
}

/** One sheet, team by team: a group header row followed by its members. */
function teamWiseSheet(wb: ExcelJS.Workbook, name: string, rows: TeamRow[], cols: [string, number][], cells: (r: TeamRow) => (string | number)[],
                       summary: (members: TeamRow[]) => string) {
  const ws = wb.addWorksheet(name);
  header(ws, cols);
  ws.getColumn(2).numFmt = '@';
  for (const members of byTeam(rows)) {
    const head = ws.addRow([`${groupLabel(members[0])} — ${members[0].team}`, '', summary(members)]);
    ws.mergeCells(head.number, 1, head.number, 2);
    head.font = { bold: true, color: { argb: 'FF1E1B4B' } };
    head.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } }; });
    members.forEach((m) => ws.addRow(cells(m)));
    ws.addRow([]);
  }
  return ws;
}

/** "Generate team report": summary per group + one team-wise sheet. */
export async function buildTeamWiseReport(eventName: string, rows: TeamRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = eventName;
  const sum = wb.addWorksheet('Summary');
  header(sum, [['Group', 12], ['Team', 28], ['Members', 10], ['Attending', 11], ['Not attending', 14], ['No response', 13], ['Veg', 8], ['Non-veg', 9], ['Collected', 11]]);
  for (const m of byTeam(rows)) {
    const n = (f: (r: TeamRow) => boolean) => m.filter(f).length;
    sum.addRow([groupLabel(m[0]), m[0].team, m.length, n((r) => r.response === 'Attending'), n((r) => r.response === 'Not attending'),
      n((r) => r.response === 'No response'), n((r) => r.meal === 'veg'), n((r) => r.meal === 'nonveg'), n((r) => !!r.collected_at)]);
  }
  teamWiseSheet(wb, 'Team-wise', rows,
    [['Group / Team', 26], ['Employee ID', 16], ['Name', 28], ['Response', 15], ['Goodie', 22], ['Meal', 10], ['Collected at (IST)', 20], ['Collected by', 16]],
    (r) => ['', r.employee_id, r.name, r.response, r.goodie ?? '', r.meal ? MEAL[r.meal] : '', ist(r.collected_at), r.collected_by ?? ''],
    (m) => `${m.length} member${m.length === 1 ? "" : "s"} · ${m.filter((r) => r.response === 'Attending').length} attending`);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** After distribution: team-wise attendance (Present = collected their goodie) + leftover goodies. */
export async function buildAttendanceReport(eventName: string, rows: TeamRow[], leftovers: Leftover[], finishedBy?: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = eventName;
  const present = (r: TeamRow) => !!r.collected_at;
  const tot = wb.addWorksheet('Team attendance');
  header(tot, [['Group', 12], ['Team', 28], ['Members', 10], ['Present', 10], ['Absent', 10], ['Present %', 11]]);
  let all = 0, pres = 0;
  for (const m of byTeam(rows)) {
    const p = m.filter(present).length;
    all += m.length; pres += p;
    tot.addRow([groupLabel(m[0]), m[0].team, m.length, p, m.length - p, m.length ? Math.round((p / m.length) * 100) / 100 : 0]);
  }
  const t = tot.addRow(['', 'TOTAL', all, pres, all - pres, all ? Math.round((pres / all) * 100) / 100 : 0]);
  t.font = { bold: true };
  tot.getColumn(6).numFmt = '0%';

  teamWiseSheet(wb, 'Team-wise list', rows,
    [['Group / Team', 26], ['Employee ID', 16], ['Name', 28], ['Present / Absent', 16], ['Goodie', 22], ['Collected at (IST)', 20], ['Note', 26]],
    (r) => ['', r.employee_id, r.name, present(r) ? 'Present' : 'Absent', r.goodie ?? '', ist(r.collected_at),
      r.response === 'Not attending' ? (r.came_at ? 'Said No — came' : 'Said No') : r.response === 'No response' ? 'No response' : ''],
    (m) => `${m.filter(present).length} present · ${m.length - m.filter(present).length} absent`);

  const left = wb.addWorksheet('Leftover goodies');
  header(left, [['Goodie', 26], ['Quantity', 10], ['Chosen', 10], ['Collected', 11], ['Chosen, not collected', 22], ['Never chosen', 14]]);
  leftovers.forEach((g) => left.addRow([g.name, g.stock, g.chosen, g.collected, g.chosen - g.collected, Math.max(g.stock - g.chosen, 0)]));

  const about = wb.addWorksheet('About');
  about.addRow([`${eventName} — attendance after goodie distribution`]);
  about.addRow([`Generated ${ist(new Date().toISOString())} IST${finishedBy ? ` by ${finishedBy}` : ''}`]);
  about.addRow(['Present = collected their goodie at the desk. Groups are numbered alphabetically by team name.']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
