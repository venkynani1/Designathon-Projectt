import { DxError } from '../errors';
import type { ParsedSheet } from './parse';

export interface RosterRow { employee_id: string; name: string; email?: string; department?: string }

const norm = (h: string) => h.toLowerCase().replace(/[^a-z]/g, '');

/** Finds the employee ID / name / email / department columns by header name. */
export function rosterColumns(headers: string[]) {
  const find = (...tests: ((h: string) => boolean)[]) => {
    for (const t of tests) { const h = headers.find((x) => t(norm(x))); if (h) return h; }
    return undefined;
  };
  const id = find((h) => ['empid', 'employeeid', 'employeeno', 'empno', 'employeenumber', 'empcode', 'employeecode', 'id', 'psno', 'staffid'].includes(h),
                  (h) => h.includes('emp') && (h.includes('id') || h.includes('no') || h.includes('code')), (h) => h.endsWith('id'));
  const name = find((h) => ['name', 'empname', 'employeename', 'fullname', 'participantname'].includes(h), (h) => h.includes('name') && !h.includes('team') && !h.includes('user'));
  const email = find((h) => h.includes('email') || h.includes('mail'));
  const department = find((h) => h.includes('dept') || h.includes('department') || h.includes('team') || h.includes('bu'));
  return { id, name, email, department };
}

export function rosterFromSheet(sheet: ParsedSheet): RosterRow[] {
  const c = rosterColumns(sheet.headers);
  if (!c.id || !c.name) {
    throw new DxError('INVALID_INPUT', `Couldn't find the columns. The first row needs headings like "Employee ID" and "Name" (found: ${sheet.headers.join(', ')})`);
  }
  return sheet.rows.map((r) => ({
    employee_id: r[c.id!] ?? '', name: r[c.name!] ?? '',
    email: c.email ? r[c.email] : undefined, department: c.department ? r[c.department] : undefined,
  }));
}

/** Pasted text: one person per line, "EMP001, Name" / tab / " - " separated, ID first or name first. */
export function rosterFromText(text: string): RosterRow[] {
  const rows: RosterRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\t|,|;|\s+-\s+|\|/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) { rows.push({ employee_id: parts[0] ?? '', name: '' }); continue; }
    const [a, b, c] = parts;
    const looksId = (s: string) => /\d/.test(s) && !/\s/.test(s);
    const [id, name] = looksId(a) || !looksId(b) ? [a, b] : [b, a];
    if (/^(emp|employee)/i.test(id) && /name/i.test(name)) continue; // header line
    rows.push({ employee_id: id, name, email: c && c.includes('@') ? c : undefined });
  }
  if (rows.length === 0) throw new DxError('INVALID_INPUT', 'Paste at least one line like: EMP1001, Asha Rao');
  return rows;
}
