import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import { DxError } from '../errors';

export const MAX_IMPORT_ROWS = 2000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export interface ParsedSheet {
  headers: string[];
  rows: Record<string, string>[];
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('hyperlink' in v) return String((v as { hyperlink: string }).hyperlink).replace(/^mailto:/, '');
  }
  return String(v);
}

function finalize(headers: string[], rows: Record<string, string>[]): ParsedSheet {
  const clean = headers.map((h) => h.trim()).filter(Boolean);
  if (clean.length === 0) throw new DxError('INVALID_INPUT', 'The file has no header row');
  if (new Set(clean.map((h) => h.toLowerCase())).size !== clean.length) {
    throw new DxError('INVALID_INPUT', 'The header row contains duplicate column names');
  }
  const nonEmpty = rows.filter((r) => Object.values(r).some((v) => v.trim() !== ''));
  if (nonEmpty.length === 0) throw new DxError('INVALID_INPUT', 'The file has no data rows');
  if (nonEmpty.length > MAX_IMPORT_ROWS) throw new DxError('INVALID_INPUT', `Maximum ${MAX_IMPORT_ROWS} rows per import`);
  return { headers: clean, rows: nonEmpty };
}

export async function parseUpload(data: ArrayBuffer | Buffer, filename: string): Promise<ParsedSheet> {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length > MAX_IMPORT_BYTES) throw new DxError('INVALID_INPUT', 'File is larger than 5 MB');
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csv')) {
    const text = buf.toString('utf8').replace(/^﻿/, '');
    const res = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim() });
    if (res.errors.length && res.data.length === 0) throw new DxError('INVALID_INPUT', `CSV error: ${res.errors[0].message}`);
    const headers = res.meta.fields ?? [];
    const rows = res.data.map((r) => Object.fromEntries(headers.map((h) => [h.trim(), String(r[h] ?? '').trim()])));
    return finalize(headers, rows);
  }
  if (lower.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
    } catch {
      throw new DxError('INVALID_INPUT', 'Could not read the XLSX file');
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new DxError('INVALID_INPUT', 'The workbook has no worksheets');
    const headerRow = ws.getRow(1);
    const headers: string[] = [];
    const colByHeader: [number, string][] = [];
    headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
      const h = cellText(cell.value).trim();
      if (h) {
        headers.push(h);
        colByHeader.push([col, h]);
      }
    });
    const rows: Record<string, string>[] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      rows.push(Object.fromEntries(colByHeader.map(([c, h]) => [h, cellText(row.getCell(c).value).trim()])));
    }
    return finalize(headers, rows);
  }
  throw new DxError('INVALID_INPUT', 'Upload a .csv or .xlsx file');
}
