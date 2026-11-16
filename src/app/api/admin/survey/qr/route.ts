import QRCode from 'qrcode';
import { route, fileResponse } from '@/lib/http';
import { requireAdmin } from '@/lib/auth/admin';
import { surveyUrl } from '@/lib/surveyUrl';

export const runtime = 'nodejs';

/** High-resolution PNG of the survey QR code, to paste into the email. */
export const GET = route(async (req) => {
  await requireAdmin({ role: 'viewer' });
  const png = await QRCode.toBuffer(surveyUrl(req.headers), { type: 'png', width: 1000, margin: 2, errorCorrectionLevel: 'M' });
  return fileResponse(png, 'goodies-survey-qr.png', 'image/png');
});
