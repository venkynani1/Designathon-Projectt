import { describe, expect, it } from 'vitest';
import { rosterColumns, rosterFromText } from '@/lib/import/roster';

describe('participant list parsing', () => {
  it('finds columns by common header names', () => {
    expect(rosterColumns(['S.No', 'Emp ID', 'Employee Name', 'Mail ID', 'Dept'])).toEqual({ id: 'Emp ID', name: 'Employee Name', email: 'Mail ID', department: 'Dept' });
    expect(rosterColumns(['PS No', 'Full Name'])).toMatchObject({ id: 'PS No', name: 'Full Name' });
  });
  it('parses pasted lines in either order', () => {
    expect(rosterFromText('Employee ID, Name\nEMP1, Asha Rao\nRavi Kumar\tEMP2\nEMP3 - Meera Iyer')).toEqual([
      { employee_id: 'EMP1', name: 'Asha Rao' },
      { employee_id: 'EMP2', name: 'Ravi Kumar' },
      { employee_id: 'EMP3', name: 'Meera Iyer' },
    ]);
  });
});

import { offlineFromSheet } from '@/lib/import/roster';
describe('offline registrations sheet', () => {
  it('maps the four columns', () => {
    const rows = offlineFromSheet({ headers: ['Employee ID', 'Employee Name', 'Veg/Non-veg', 'Goodie'], rows: [{ 'Employee ID': '1001', 'Employee Name': 'A B', 'Veg/Non-veg': 'Non Veg', Goodie: 'Hoodie' }] });
    expect(rows[0]).toEqual({ employee_id: '1001', name: 'A B', meal: 'Non Veg', goodie: 'Hoodie' });
  });
});
