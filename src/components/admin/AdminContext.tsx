'use client';
import { createContext, useContext } from 'react';
import type { AdminUser } from '@/lib/auth/roles';

const Ctx = createContext<AdminUser | null>(null);
export const AdminProvider = ({ admin, children }: { admin: AdminUser; children: React.ReactNode }) => <Ctx.Provider value={admin}>{children}</Ctx.Provider>;

const RANK = { viewer: 1, registrar: 2, admin: 3, superadmin: 4 } as const;
export function useAdmin() {
  const a = useContext(Ctx)!;
  return { ...a, atLeast: (r: keyof typeof RANK) => RANK[a.role] >= RANK[r], isSuper: a.role === 'superadmin' };
}
