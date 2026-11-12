import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildPlan, suggestMapping, type ImportContext } from '@/lib/import/plan';
import { parseUpload } from '@/lib/import/parse';

const ctx = (over: Partial<ImportContext> = {}): ImportContext => ({
  teams: Array.from({ length: 10 }, (_, i) => ({ id: `t${i + 1}`, team_number: i + 1, name: null, status: 'unregistered', occupied: 0 })),
  employee_ids: [], emails: [], frozen: false, ...over,
});

describe('team-format import', () => {
  const headers = ['Team No', 'Team Name', 'P1 Name', 'P1 Emp ID', 'P2 Name', 'P2 Emp ID', 'P3 Name', 'P3 Emp ID', 'P4 Name', 'P4 Emp ID'];
  const mapping = suggestMapping(headers, 'team');

  it('suggests a sensible mapping', () => {
    expect(mapping).toMatchObject({ team_number: 'Team No', team_name: 'Team Name', p1_name: 'P1 Name', p1_employee_id: 'P1 Emp ID', p4_employee_id: 'P4 Emp ID' });
  });

  it('assigns 2, 3 and 4 participants to P1..Pn in source order', () => {
    const row = (no: string, name: string, n: number) => ({
      'Team No': no, 'Team Name': name,
      ...Object.fromEntries([1, 2, 3, 4].flatMap((k) => (k <= n ? [[`P${k} Name`, `${name}-${k}`], [`P${k} Emp ID`, `${name}${k}`.toUpperCase()]] : [[`P${k} Name`, ''], [`P${k} Emp ID`, '']]))),
    });
    const plan = buildPlan('team', [row('3', 'Two', 2), row('', 'Three', 3), row('', 'Four', 4)], mapping, ctx());
    expect(plan.errors).toEqual([]);
    const two = plan.teams.find((t) => t.team_name === 'Two')!;
    expect(two.team_number).toBe(3);
    expect(two.members.map((m) => m.name)).toEqual(['Two-1', 'Two-2']);
    const three = plan.teams.find((t) => t.team_name === 'Three')!;
    expect(three.team_number).toBe(1); // first vacant, explicit #3 already claimed
    expect(three.members).toHaveLength(3);
    expect(plan.teams.find((t) => t.team_name === 'Four')!.team_number).toBe(2);
    expect(plan.summary.by_size).toEqual({ '2': 1, '3': 1, '4': 1 });
  });
});

describe('participant-format import validation', () => {
  const mapping = { team_number: 'Team', team_name: 'Team Name', name: 'Name', employee_id: 'Emp', email: 'Email' };
  const r = (Team: string, TeamName: string, Name: string, Emp: string, Email = '') => ({ Team, 'Team Name': TeamName, Name, Emp, Email });

  it('detects duplicates, size violations, conflicts and never overwrites occupied teams', () => {
    const plan = buildPlan('participant', [
      r('1', 'A', 'a1', 'E1'), r('1', 'A', 'a2', 'E1'),          // dup employee in file
      r('2', 'B', 'b1', 'E3'),                                     // team of one
      r('4', 'C', 'c1', 'TAKEN'), r('4', 'C', 'c2', 'E5'),         // already registered employee + occupied team
      r('99', 'D', 'd1', 'E6'), r('99', 'D', 'd2', 'E7'),          // team not generated
      r('5', 'E', 'e1', 'E8', 'bad-email'), r('5', 'E', 'e2', 'E9'),
    ], mapping, ctx({
      teams: ctx().teams.map((t) => (t.team_number === 4 ? { ...t, occupied: 2, status: 'registered' } : t)),
      employee_ids: ['TAKEN'],
    }));
    const msgs = plan.errors.map((e) => e.message).join('\n');
    expect(msgs).toContain('Duplicate employee ID E1');
    expect(msgs).toContain('needs 2–4 participants (found 1)');
    expect(msgs).toContain('TAKEN is already registered');
    expect(msgs).toContain('will not be overwritten');
    expect(msgs).toContain('Team 099 has not been generated');
    expect(msgs).toContain('Invalid email');
  });

  it('reports when there are not enough pre-generated teams', () => {
    const rows = Array.from({ length: 12 }, (_, i) => [r('', `T${i}`, `x${i}`, `X${i}A`), r('', `T${i}`, `y${i}`, `X${i}B`)]).flat();
    const plan = buildPlan('participant', rows, mapping, ctx());
    expect(plan.errors.some((e) => e.message.includes('generate 2 more'))).toBe(true);
  });

  it('detects duplicate team names against existing teams', () => {
    const plan = buildPlan('participant', [r('', 'Taken Name', 'a', 'A1'), r('', 'Taken Name', 'b', 'B1')], mapping,
      ctx({ teams: ctx().teams.map((t) => (t.team_number === 9 ? { ...t, name: 'Taken Name', occupied: 2, status: 'registered' } : t)) }));
    expect(plan.errors.some((e) => e.message.includes('already used by Team 009'))).toBe(true);
  });
});

describe('file parsing', () => {
  it('parses CSV with BOM and XLSX with numeric employee IDs', async () => {
    const csv = await parseUpload(Buffer.from('﻿Name,Emp\nArun,2000168956\n,\n'), 'a.csv');
    expect(csv.headers).toEqual(['Name', 'Emp']);
    expect(csv.rows).toEqual([{ Name: 'Arun', Emp: '2000168956' }]);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['Name', 'Emp']);
    ws.addRow(['Priya', 2000168957]);
    const x = await parseUpload(Buffer.from(await wb.xlsx.writeBuffer()), 'b.xlsx');
    expect(x.rows).toEqual([{ Name: 'Priya', Emp: '2000168957' }]);
    await expect(parseUpload(Buffer.from('x'), 'c.txt')).rejects.toThrow(/csv or .xlsx/);
  });
});
