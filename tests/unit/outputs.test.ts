import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { buildTeamReport, REPORT_COLUMNS } from '@/lib/reports/excel';
import { renderSlipsPdf, pdfSafe } from '@/lib/pdf/slips';
import { authorize, authorizePrivileged, type AdminUser } from '@/lib/auth/roles';
import { DxError } from '@/lib/errors';
import { fromDbError } from '@/lib/errors';

const admin = (role: AdminUser['role'], can = false): AdminUser => ({ user_id: 'u', email: 'a@b.c', display_name: null, role, can_issue_credentials: can });

describe('Excel report', () => {
  it('has exactly the required columns and no credentials', async () => {
    const buf = await buildTeamReport('Designathon X', [{
      team_number: 40, team_name: 'Design Ninjas', registration_source: 'walk_in', registration_status: 'registered',
      assignment: 'PS-01 — One',
      slots: [
        { slot_number: 1, name: 'Arun', employee_id: '2000168956', reservation: 'Hoodie (reserved)' },
        { slot_number: 2, name: 'Priya', employee_id: '2000168957', reservation: null },
        { slot_number: 3, name: null, employee_id: null, reservation: null },
        { slot_number: 4, name: null, employee_id: null, reservation: null },
      ],
    }]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Teams')!;
    expect((ws.getRow(1).values as unknown[]).slice(1)).toEqual([...REPORT_COLUMNS]);
    const row = (ws.getRow(2).values as unknown[]).slice(1);
    expect(row[0]).toBe('Team 040');
    expect(row[4]).toBe('2000168956');
    expect(row[6]).toBe('2000168957');
    expect(row[13]).toBe('1/2 reserved — P1: Hoodie (reserved)');
    expect(JSON.stringify(row).toLowerCase()).not.toContain('pin');
  });
});

describe('PDF slips', () => {
  it('renders two teams per A4 page with detachable PIN coupons', async () => {
    const team = (n: number) => ({
      team_number: n, team_name: `Équipe ${n} 🚀`, team_pin: '482913', team_pin_state: 'available' as const,
      members: [1, 2, 3, 4].map((s) => ({ slot_number: s, name: s < 3 ? `Member ${s}` : null, employee_id: s < 3 ? `E${s}` : null, pin: s === 4 ? null : '571946', pin_state: (s === 4 ? 'reissue_required' : 'available') as 'available' | 'reissue_required' })),
    });
    const bytes = await renderSlipsPdf({ name: 'Designathon X' }, [team(1), team(2), team(3)]);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    const [w, h] = [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()];
    expect(Math.round(w)).toBe(595);
    expect(Math.round(h)).toBe(842);
    expect(pdfSafe('Équipe 🚀')).toBe('Equipe ?');
  });
});

describe('authorization', () => {
  it('enforces role ranks and credential issuance permission', () => {
    expect(() => authorize(null, { role: 'viewer' })).toThrow(DxError);
    expect(() => authorize(admin('viewer'), { role: 'registrar' })).toThrow(/registrar/);
    expect(authorize(admin('admin'), { role: 'registrar' }).role).toBe('admin');
    expect(() => authorize(admin('superadmin', false), { role: 'admin', issueCredentials: true })).toThrow(/issuance/);
    expect(authorize(admin('admin', true), { role: 'admin', issueCredentials: true }).can_issue_credentials).toBe(true);
    expect(() => authorizePrivileged(admin('admin'), true)).toThrow(/superadmin/);
    expect(authorizePrivileged(admin('superadmin'), true)).toBe(true);
    expect(authorizePrivileged(admin('registrar'), false)).toBe(false);
  });

  it('maps database errors to typed API errors', () => {
    const e = fromDbError({ message: 'DX:ALREADY_ASSIGNED:Your team has already locked a problem statement' }) as DxError;
    expect(e.code).toBe('ALREADY_ASSIGNED');
    expect(e.status).toBe(409);
    expect((fromDbError({ message: 'boom' }) as DxError).status).toBe(500);
  });
});

import { buildAttendanceReport, buildTeamWiseReport } from '@/lib/reports/teams';
import ExcelJS2 from 'exceljs';
describe('team reports', () => {
  const rows = [
    { group: 1, team: 'Alpha', employee_id: '1', name: 'A', response: 'Attending' as const, goodie: 'Tee', meal: 'veg' as const, collected_at: '2026-11-27T05:00:00Z', collected_by: 'P', came_at: null },
    { group: 1, team: 'Alpha', employee_id: '2', name: 'B', response: 'No response' as const, goodie: null, meal: null, collected_at: null, collected_by: null, came_at: null },
  ];
  it('builds team-wise and attendance workbooks', async () => {
    const wb = new ExcelJS2.Workbook();
    await wb.xlsx.load((await buildTeamWiseReport('E', rows)) as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Team-wise']);
    const at = new ExcelJS2.Workbook();
    await at.xlsx.load((await buildAttendanceReport('E', rows, [{ name: 'Tee', stock: 5, chosen: 1, collected: 1 }])) as unknown as ArrayBuffer);
    const tot = at.getWorksheet('Team attendance')!;
    expect(tot.getRow(2).values).toEqual([undefined, 'Group 1', 'Alpha', 2, 1, 1, 0.5]);
  });
});
