import { NextResponse } from 'next/server';
import { route } from '@/lib/http';
import { db } from '@/lib/server/db';
import { uuid } from '@/lib/validation';
import { DxError } from '@/lib/errors';

type Ctx = { params: Promise<{ id: string }> };

/** Goodie photo. URLs carry ?v=<version>, so the photo can be cached forever by browsers and the CDN. */
export const GET = route<Ctx>(async (_req, { params }) => {
  const id = uuid.parse((await params).id);
  const img = await db().rpc<{ mime: string; data: string } | null>('get_goodie_image', { p_goodie: id });
  if (!img) throw new DxError('NOT_FOUND', 'No photo');
  return new NextResponse(new Uint8Array(Buffer.from(img.data, 'base64')), {
    headers: { 'Content-Type': img.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' },
  });
});
