export type DxCode =
  | 'NOT_FOUND' | 'FROZEN' | 'REASON_REQUIRED' | 'DUPLICATE_EMPLOYEE' | 'DUPLICATE_TEAM_NAME'
  | 'TEAM_NOT_EMPTY' | 'TEAM_SIZE' | 'TEAM_FULL' | 'TEAM_WITHDRAWN' | 'SLOT_OCCUPIED' | 'NOT_OCCUPIED'
  | 'ALREADY_ASSIGNED' | 'PROBLEM_FULL' | 'ALREADY_RESERVED' | 'OUT_OF_STOCK' | 'ARENA_CLOSED'
  | 'TEAM_NOT_ELIGIBLE' | 'NOT_ELIGIBLE' | 'SESSION_INVALID' | 'PACKAGE_EXPIRED' | 'PIN_COLLISION'
  | 'IMMUTABLE' | 'INVALID_INPUT' | 'INVALID_MEMBER' | 'INVALID_NAME' | 'INVALID_STATE' | 'IMPORT_HAS_ERRORS'
  | 'INVALID_CREDENTIALS' | 'CREDENTIAL_WITHDRAWN' | 'RATE_LIMITED' | 'UNAUTHORIZED' | 'FORBIDDEN'
  | 'CSRF' | 'CONFIG' | 'INTERNAL';

const STATUS: Partial<Record<DxCode, number>> = {
  NOT_FOUND: 404, FROZEN: 423, REASON_REQUIRED: 400, DUPLICATE_EMPLOYEE: 409, DUPLICATE_TEAM_NAME: 409,
  TEAM_NOT_EMPTY: 409, TEAM_SIZE: 400, TEAM_FULL: 409, TEAM_WITHDRAWN: 409, SLOT_OCCUPIED: 409, NOT_OCCUPIED: 409,
  ALREADY_ASSIGNED: 409, PROBLEM_FULL: 409, ALREADY_RESERVED: 409, OUT_OF_STOCK: 409, ARENA_CLOSED: 403,
  TEAM_NOT_ELIGIBLE: 403, NOT_ELIGIBLE: 403, SESSION_INVALID: 401, PACKAGE_EXPIRED: 410, PIN_COLLISION: 503,
  IMMUTABLE: 409, INVALID_STATE: 409, IMPORT_HAS_ERRORS: 422, INVALID_CREDENTIALS: 401, CREDENTIAL_WITHDRAWN: 403,
  RATE_LIMITED: 429, UNAUTHORIZED: 401, FORBIDDEN: 403, CSRF: 403, CONFIG: 500, INTERNAL: 500,
};

export class DxError extends Error {
  readonly code: DxCode;
  readonly status: number;
  readonly meta?: Record<string, unknown>;
  constructor(code: DxCode, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.name = 'DxError';
    this.code = code;
    this.status = STATUS[code] ?? 400;
    this.meta = meta;
  }
}

/** Converts a PostgreSQL / PostgREST error raised by dx_raise() into a DxError. */
export function fromDbError(err: unknown): Error {
  const msg = typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : String(err);
  const m = /^DX:([A-Z_]+):([\s\S]*)$/.exec(msg);
  if (m) return new DxError(m[1] as DxCode, m[2]);
  const code = typeof err === 'object' && err && 'code' in err ? String((err as { code: unknown }).code) : '';
  if (code === '23505') return new DxError('INVALID_STATE', 'A conflicting record already exists');
  if (code === '23514' || code === '23503') return new DxError('INVALID_INPUT', 'The change violates a data integrity rule');
  return new DxError('INTERNAL', 'Unexpected database error', { cause: msg });
}
