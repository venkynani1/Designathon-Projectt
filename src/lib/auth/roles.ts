import { DxError } from '../errors';

export type AdminRole = 'viewer' | 'registrar' | 'admin' | 'superadmin';
export interface AdminUser {
  user_id: string;
  email: string;
  display_name: string | null;
  role: AdminRole;
  can_issue_credentials: boolean;
}

const RANK: Record<AdminRole, number> = { viewer: 1, registrar: 2, admin: 3, superadmin: 4 };

export interface Requirement {
  role: AdminRole;
  /** Viewing/printing plaintext credentials or reissuing them. */
  issueCredentials?: boolean;
}

/** Pure authorization check (unit-tested). */
export function authorize(admin: AdminUser | null, req: Requirement): AdminUser {
  if (!admin) throw new DxError('UNAUTHORIZED', 'Administrator sign-in required');
  if (RANK[admin.role] < RANK[req.role]) throw new DxError('FORBIDDEN', `Requires ${req.role} role`);
  if (req.issueCredentials && !admin.can_issue_credentials) {
    throw new DxError('FORBIDDEN', 'Credential issuance permission required');
  }
  return admin;
}

/** Privileged exceptions after the freeze are superadmin-only. */
export function authorizePrivileged(admin: AdminUser, privileged: boolean | undefined): boolean {
  if (!privileged) return false;
  if (admin.role !== 'superadmin') throw new DxError('FORBIDDEN', 'Only a superadmin can perform privileged post-freeze changes');
  return true;
}
