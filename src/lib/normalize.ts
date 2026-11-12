export const normalizeEmployeeId = (v: unknown): string =>
  String(v ?? '').replace(/\s+/g, '').toUpperCase();

export const normalizeEmail = (v: unknown): string | null => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '' ? null : s;
};

export const normalizeName = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();

export const EMPLOYEE_ID_RE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const teamLabel = (n: number): string => `Team ${String(n).padStart(3, '0')}`;
