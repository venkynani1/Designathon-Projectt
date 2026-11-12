import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type PDFImage } from 'pdf-lib';
import QRCode from 'qrcode';
import { teamLabel } from '../normalize';

export type PinState = 'available' | 'reissue_required' | 'withheld';

export interface SlipTeam {
  team_number: number;
  team_name: string | null;
  team_pin: string | null;
  team_pin_state: PinState;
  members: { slot_number: number; name: string | null; employee_id: string | null; pin: string | null; pin_state: PinState }[];
}

export interface SlipEvent {
  name: string;
  tagline?: string | null;
  venue?: string | null;
  brand_color?: string | null;
  problems_qr_url?: string | null;
  goodies_qr_url?: string | null;
}

const A4: [number, number] = [595.28, 841.89];
const M = 28;

/** Standard PDF fonts only cover WinAnsi; transliterate/replace anything else. */
export function pdfSafe(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E\xA0-\xFF]/gu, '?');
}

function hexToRgb(hex: string | null | undefined) {
  const h = /^#([0-9a-f]{6})$/i.exec(hex ?? '') ? hex!.slice(1) : '4338ca';
  return rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
}

function fit(text: string, font: PDFFont, size: number, max: number): string {
  const full = pdfSafe(text);
  if (font.widthOfTextAtSize(full, size) <= max) return full;
  let t = full;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > max) t = t.slice(0, -1);
  return `${t.trimEnd()}...`;
}

function dashedLine(page: PDFPage, x1: number, y1: number, x2: number, y2: number) {
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.7, color: rgb(0.55, 0.55, 0.55), dashArray: [4, 3] });
}

function pinLabel(pin: string | null, state: PinState): string {
  if (pin) return pin.replace(/(\d{3})(\d{3})/, '$1 $2');
  return state === 'withheld' ? '••• •••' : 'REISSUE';
}

/**
 * A4, two teams per page. Each team section = header (team PIN + instructions + QR codes)
 * and four detachable personal-PIN coupons, so each teammate receives only their own PIN.
 */
export async function renderSlipsPdf(event: SlipEvent, teams: SlipTeam[], opts: { title?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(opts.title ?? `${event.name} — Team credential slips`);
  doc.setCreator('Designathon X Credential System');
  doc.setProducer('pdf-lib');
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const mono = await doc.embedFont(StandardFonts.CourierBold);
  const brand = hexToRgb(event.brand_color);
  const grey = rgb(0.35, 0.35, 0.4);

  const qr = async (url?: string | null): Promise<PDFImage | null> =>
    url ? doc.embedPng(await QRCode.toBuffer(url, { type: 'png', margin: 1, width: 240, errorCorrectionLevel: 'M' })) : null;
  const qrProblems = await qr(event.problems_qr_url);
  const qrGoodies = await qr(event.goodies_qr_url);

  const half = A4[1] / 2;
  let page: PDFPage | null = null;

  teams.forEach((t, idx) => {
    if (idx % 2 === 0) page = doc.addPage(A4);
    const p = page!;
    const top = idx % 2 === 0 ? A4[1] - M : half - M / 2;
    const W = A4[0] - 2 * M;
    if (idx % 2 === 0 && idx + 1 < teams.length) dashedLine(p, M / 2, half + 4, A4[0] - M / 2, half + 4);

    // header band
    p.drawRectangle({ x: M, y: top - 34, width: W, height: 34, color: brand });
    p.drawText(fit(event.name, bold, 15, 300), { x: M + 12, y: top - 22, size: 15, font: bold, color: rgb(1, 1, 1) });
    if (event.tagline) p.drawText(fit(event.tagline, regular, 8, 200), { x: M + 12, y: top - 31, size: 7.5, font: regular, color: rgb(1, 1, 1) });
    const label = teamLabel(t.team_number).toUpperCase();
    p.drawText(label, { x: M + W - 12 - bold.widthOfTextAtSize(label, 18), y: top - 24, size: 18, font: bold, color: rgb(1, 1, 1) });

    // team block
    let y = top - 56;
    p.drawText('TEAM NAME', { x: M + 4, y, size: 7, font: bold, color: grey });
    p.drawText(fit(t.team_name ?? teamLabel(t.team_number), bold, 14, 300), { x: M + 4, y: y - 16, size: 14, font: bold });
    p.drawText('TEAM PIN  (Problem Statement Arena)', { x: M + 4, y: y - 36, size: 7, font: bold, color: grey });
    p.drawRectangle({ x: M + 4, y: y - 70, width: 150, height: 28, borderColor: brand, borderWidth: 1.2, color: rgb(0.97, 0.97, 1) });
    p.drawText(pinLabel(t.team_pin, t.team_pin_state), { x: M + 14, y: y - 63, size: 20, font: mono, color: t.team_pin ? rgb(0, 0, 0) : rgb(0.75, 0.1, 0.1) });

    const instr = [
      '1. Problem Statement Arena: scan the QR, find your team number or name,',
      '   enter the TEAM PIN and lock ONE problem statement (shared by the whole team).',
      '2. Goodies Arena: scan the QR, enter YOUR employee ID and YOUR personal PIN',
      '   (coupon below). One goodie per participant — reservations are final.',
      '3. Never share personal PINs. Lost or exposed PIN? Visit the registration desk.',
    ];
    instr.forEach((line, i) => p.drawText(pdfSafe(line), { x: M + 4, y: y - 86 - i * 10, size: 7.5, font: regular, color: grey }));

    // QR codes
    const qrSize = 74;
    const qrs: [PDFImage | null, string][] = [[qrProblems, 'Problem Arena'], [qrGoodies, 'Goodies Arena']];
    qrs.filter(([img]) => img).forEach(([img, cap], i, arr) => {
      const x = M + W - (arr.length - i) * (qrSize + 12);
      p.drawImage(img!, { x, y: y - 76, width: qrSize, height: qrSize });
      p.drawText(cap, { x: x + (qrSize - regular.widthOfTextAtSize(cap, 7)) / 2, y: y - 86, size: 7, font: regular, color: grey });
    });
    p.drawText('CONFIDENTIAL — team leader keeps this section', { x: M + W - 190, y: y - 132, size: 6.5, font: bold, color: rgb(0.7, 0.1, 0.1) });

    // detachable coupons
    const cy = y - 142;
    dashedLine(p, M, cy, M + W, cy);
    p.drawText('- - cut here - -', { x: M + W / 2 - 25, y: cy + 3, size: 6, font: regular, color: grey });
    const cw = W / 4;
    const ch = 118;
    t.members.forEach((m, i) => {
      const x = M + i * cw;
      if (i > 0) dashedLine(p, x, cy, x, cy - ch);
      const pad = 8;
      p.drawText(fit(`${event.name} · ${teamLabel(t.team_number)}`, regular, 6.5, cw - 2 * pad), { x: x + pad, y: cy - 14, size: 6.5, font: regular, color: grey });
      p.drawText(`P${m.slot_number}`, { x: x + pad, y: cy - 32, size: 16, font: bold, color: brand });
      p.drawText(fit(m.name ?? 'Unassigned slot', bold, 8.5, cw - 2 * pad - 30), { x: x + pad + 30, y: cy - 25, size: 8.5, font: bold });
      p.drawText(fit(m.employee_id ? `Emp ID ${m.employee_id}` : 'Keep at registration desk', regular, 6.5, cw - 2 * pad - 30), {
        x: x + pad + 30, y: cy - 35, size: 6.5, font: regular, color: grey,
      });
      p.drawText('PERSONAL PIN', { x: x + pad, y: cy - 52, size: 6.5, font: bold, color: grey });
      p.drawText(pinLabel(m.pin, m.pin_state), { x: x + pad, y: cy - 72, size: 17, font: mono, color: m.pin ? rgb(0, 0, 0) : rgb(0.75, 0.1, 0.1) });
      ['Goodies Arena login:', 'Employee ID + this PIN.', 'Do not share. Valid all event.'].forEach((l, k) =>
        p.drawText(l, { x: x + pad, y: cy - 88 - k * 8.5, size: 6.3, font: regular, color: grey }),
      );
    });
    dashedLine(p, M, cy - ch, M + W, cy - ch);
  });

  if (teams.length === 0) {
    const p = doc.addPage(A4);
    p.drawText('No teams matched this selection.', { x: M, y: A4[1] - 60, size: 12, font: regular });
  }
  return doc.save();
}
