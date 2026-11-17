import { route, json } from '@/lib/http';
import { db } from '@/lib/server/db';
import { DxError } from '@/lib/errors';

type Ctx = { params: Promise<{ token: string }> };
const tok = async (p: Ctx['params']) => {
  const t = (await p).token;
  if (!/^[a-f0-9]{32}$/.test(t)) throw new DxError('NOT_FOUND', 'This link is not valid');
  return t;
};

/** Public: who this personal link belongs to and whether they've got their goodie. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const info = await db().rpc('autopick_peek', { p_token: await tok(params) });
  if (!info) throw new DxError('NOT_FOUND', 'This link is not valid');
  return json(info);
});

/** Public: claim the first available preferred goodie. Safe to call repeatedly. */
export const POST = route<Ctx>(async (_req, { params }) => json(await db().rpc('autopick_claim', { p_token: await tok(params) })));
