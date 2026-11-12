import { route, json } from '@/lib/http';
import { db, serviceClient } from '@/lib/supabase/server';
import { requireArenaSession } from '@/lib/arenaSession';

interface Problem { id: string; code: string; title: string; summary: string | null; capacity: number; remaining: number; document_path: string | null }
interface State { problems: Problem[]; [k: string]: unknown }

/** Team-level state, shared by every teammate signed in with the same team PIN. */
export const GET = route(async () => {
  const s = await requireArenaSession(db(), 'team');
  const state = await db().rpc<State>('team_arena_state', { p_team: s.team_id });
  const storage = serviceClient().storage.from('problem-docs');
  const problems = await Promise.all(
    state.problems.map(async ({ document_path, ...p }) => {
      if (!document_path) return { ...p, document_url: null };
      const { data } = await storage.createSignedUrl(document_path, 600);
      return { ...p, document_url: data?.signedUrl ?? null };
    }),
  );
  return json({ ...state, problems });
});
