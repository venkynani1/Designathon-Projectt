import { route, json } from '@/lib/http';
import { clearDeskCookie } from '@/lib/auth/desk';

export const POST = route(async () => { const res = json({ ok: true }); clearDeskCookie(res); return res; });
