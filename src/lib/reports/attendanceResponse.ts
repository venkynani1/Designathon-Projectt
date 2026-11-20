import type { Db } from '../db';
import { fileResponse } from '../http';
import { buildAttendanceReport, type Leftover, type TeamRow } from './teams';

export async function attendanceFile(db: Db, ev: { id: string; code: string; name: string }, by?: string) {
  const [rows, left] = await Promise.all([
    db.rpc<TeamRow[]>('admin_team_rows', { p_event: ev.id }),
    db.rpc<Leftover[]>('admin_leftover_goodies', { p_event: ev.id }),
  ]);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return fileResponse(await buildAttendanceReport(ev.name, rows, left, by), `${ev.code}-attendance-${stamp}.xlsx`,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}
