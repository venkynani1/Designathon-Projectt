import { route, json, body, clientIp } from '@/lib/http';
import { db } from '@/lib/supabase/server';
import { currentEvent } from '@/lib/event';
import { teamLoginSchema } from '@/lib/validation';
import { authenticateTeam, openArenaSession } from '@/lib/services/arenaAuth';
import { setSessionCookie } from '@/lib/arenaSession';

export const runtime = 'nodejs';

export const POST = route(async (req) => {
  const { team_number, pin } = await body(req, teamLoginSchema);
  const ev = await currentEvent(db());
  const ip = clientIp(req);
  const auth = await authenticateTeam(db(), { eventId: ev.id, teamNumber: team_number, pin, ip });
  const s = await openArenaSession(db(), {
    eventId: ev.id, kind: 'team', teamId: auth.teamId, credentialId: auth.credentialId, ip, userAgent: req.headers.get('user-agent') ?? '',
  });
  const res = json({ ok: true });
  setSessionCookie(res, 'team', s.token, s.maxAgeSeconds);
  return res;
});
