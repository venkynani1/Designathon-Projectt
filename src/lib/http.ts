import { NextResponse, type NextRequest } from 'next/server';
import { ZodError, type ZodType } from 'zod';
import { DxError } from './errors';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' };

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: NO_STORE });
}

export function fileResponse(body: Uint8Array | Buffer, filename: string, type: string): NextResponse {
  return new NextResponse(new Uint8Array(body), {
    headers: { ...NO_STORE, 'Content-Type': type, 'Content-Disposition': `attachment; filename="${filename}"` },
  });
}

export function clientIp(req: NextRequest): string {
  return (req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0] ?? 'unknown').trim().slice(0, 64);
}

/** CSRF defence for cookie-authenticated mutations: require a same-origin Origin header. */
export function assertSameOrigin(req: NextRequest): void {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.get('origin');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!origin || !host) throw new DxError('CSRF', 'Missing origin');
  try {
    if (new URL(origin).host !== host) throw new DxError('CSRF', 'Cross-origin request rejected');
  } catch (e) {
    if (e instanceof DxError) throw e;
    throw new DxError('CSRF', 'Invalid origin');
  }
}

export async function body<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new DxError('INVALID_INPUT', 'Request body must be JSON');
  }
  return schema.parse(raw);
}

type Handler<C> = (req: NextRequest, ctx: C) => Promise<Response>;

/** Uniform error handling: typed DxErrors become JSON with the right status; everything else is a 500 without internals. */
export function route<C>(fn: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      assertSameOrigin(req);
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof ZodError) {
        return json({ error: { code: 'INVALID_INPUT', message: e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') } }, 400);
      }
      if (e instanceof DxError) {
        const headers = e.code === 'RATE_LIMITED' && e.meta?.retryAfter ? { 'Retry-After': String(e.meta.retryAfter) } : undefined;
        const res = json({ error: { code: e.code, message: e.status >= 500 ? 'Server error — please retry or contact the desk' : e.message } }, e.status);
        if (headers) Object.entries(headers).forEach(([k, v]) => res.headers.set(k, v));
        if (e.status >= 500) console.error('[dx]', e.code, e.message, e.meta);
        return res;
      }
      console.error('[dx] unhandled', e);
      return json({ error: { code: 'INTERNAL', message: 'Server error — please retry or contact the desk' } }, 500);
    }
  };
}
