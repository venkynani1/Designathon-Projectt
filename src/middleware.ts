import { NextResponse, type NextRequest } from 'next/server';

/**
 * Cheap gate for the organizer console: no session cookie → login page.
 * The real check (session valid, admin active, role) happens server-side on every request.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith('/admin/login') || req.cookies.get('dx_admin_session')?.value) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = '/admin/login';
  url.search = `?next=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = { matcher: ['/admin/:path*'] };
