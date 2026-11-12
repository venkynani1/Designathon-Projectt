import ExcelJS from 'exceljs';
import { teamLabel } from '../normalize';

export interface ReportRow {
  team_number: number;
  team_name: string | null;
  registration_source: string;
  registration_status: string;
  assignment: string | null;
  slots: { slot_number: number; name: string | null; employee_id: string | null; reservation: string | null }[];
}

export const REPORT_COLUMNS = [
  'Team Number', 'Team Name', 'Registration Source',
  'P1 Name', 'P1 Employee ID', 'P2 Name', 'P2 Employee ID', 'P3 Name', 'P3 Employee ID', 'P4 Name', 'P4 Employee ID',
  'Team Registration Status', 'Problem Statement Assignment', 'Goodies Reservation Status',
] as const;

const SOURCE: Record<string, string> = { pregenerated: 'Pre-generated', online_import: 'Online import', walk_in: 'Walk-in', admin: 'Admin' };
const STATUS: Record<string, string> = { unregistered: 'Unregistered', incomplete: 'Incomplete (1 member)', registered: 'Registered', withdrawn: 'Withdrawn' };

export function goodiesStatus(slots: ReportRow['slots']): string {
  const occupied = slots.filter((s) => s.name);
  if (occupied.length === 0) return '—';
  const reserved = occupied.filter((s) => s.reservation);
  const detail = reserved.map((s) => `P${s.slot_number}: ${s.reservation}`).join('; ');
  return `${reserved.length}/${occupied.length} reserved${detail ? ` — ${detail}` : ''}`;
}

/** Ordinary export: contains NO PINs, hashes or fingerprints by construction. */
export async function buildTeamReport(eventName: string, rows: ReportRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Designathon X Credential System';
  wb.created = new Date();
  const ws = wb.addWorksheet('Teams', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = REPORT_COLUMNS.map((header) => ({ header, key: header, width: header.includes('Name') || header.includes('Assignment') ? 26 : 16 }));
  ws.getColumn('Goodies Reservation Status').width = 44;
  for (const r of rows) {
    const slot = (n: number) => r.slots.find((s) => s.slot_number === n);
    ws.addRow([
      teamLabel(r.team_number), r.team_name ?? '', SOURCE[r.registration_source] ?? r.registration_source,
      slot(1)?.name ?? '', slot(1)?.employee_id ?? '', slot(2)?.name ?? '', slot(2)?.employee_id ?? '',
      slot(3)?.name ?? '', slot(3)?.employee_id ?? '', slot(4)?.name ?? '', slot(4)?.employee_id ?? '',
      STATUS[r.registration_status] ?? r.registration_status, r.assignment ?? 'Not selected', goodiesStatus(r.slots),
    ]);
  }
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4338CA' } };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: REPORT_COLUMNS.length } };
  // employee IDs as text so Excel never mangles long numeric IDs
  ['E', 'G', 'I', 'K'].forEach((c) => (ws.getColumn(c).numFmt = '@'));
  const meta = wb.addWorksheet('About');
  meta.addRow([`${eventName} — registration report`]);
  meta.addRow([`Generated ${new Date().toISOString()}`]);
  meta.addRow(['This export intentionally contains no credentials. PINs are issued only through the controlled slip workflow.']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
