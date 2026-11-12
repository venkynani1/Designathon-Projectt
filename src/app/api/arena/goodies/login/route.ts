import { route, json, body, clientIp } from '@/lib/http';
import { db } from '@/lib/supabase/server';
import { currentEvent } from '@/lib/event';
import { participantLoginSchema } from '@/lib/validation';
import { authenticateParticipant, openArenaSession } from '@/lib/services/arenaAuth';
import { setSessionCookie } from '@/lib/arenaSession';

export const runtime = 'nodejs';

export const POST = route(async (req) => {
  const { employee_id, pin } = await body(req, participantLoginSchema);
  const ev = await currentEvent(db());
  const ip = clientIp(req);
  const a = await authenticateParticipant(db(), { eventId: ev.id, employeeId: employee_id, pin, ip });
  const s = await openArenaSession(db(), {
    eventId: ev.id, kind: 'participant', teamId: a.teamId, slotId: a.slotId, identityId: a.identityId, credentialId: a.credentialId,
    ip, userAgent: req.headers.get('user-agent') ?? '',
  });
  const res = json({ ok: true });
  setSessionCookie(res, 'participant', s.token, s.maxAgeSeconds);
  return res;
});
