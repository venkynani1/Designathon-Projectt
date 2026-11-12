import { authClient, db } from '../supabase/server';
import { authorize, type AdminUser, type Requirement } from './roles';

/** Resolves the signed-in Supabase Auth user (validated with the Auth server) to an admin record. */
export async function currentAdmin(): Promise<AdminUser | null> {
  const supabase = await authClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return db().rpc<AdminUser | null>('get_admin_user', { p_user: data.user.id });
}

export async function requireAdmin(req: Requirement): Promise<AdminUser> {
  return authorize(await currentAdmin(), req);
}
