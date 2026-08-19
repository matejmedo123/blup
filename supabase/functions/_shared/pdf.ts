/**
 * A very small PDF writer — enough for one ticket per page: a heading, a few
 * lines of text, and the QR drawn as filled squares.
 *
 * Why not an HTML email with an inline image: Gmail strips `data:` image URIs,
 * and a remote `<img>` would mean handing every ticket's secret to whoever
 * hosts it. A PDF attachment is the one thing that survives every mail client,
 * prints, and works offline at the door.
 *
 * Only WinAnsi (Latin-1) characters survive in the standard fonts, so text is
 * transliterated before it is written — a mangled event title on a ticket is
 * worse than an unaccented one.
 */
import { encodeQr } from './qr.ts';

const PAGE_WIDTH = 420;   // points — a compact ticket, roughly A6 landscape-ish
const PAGE_HEIGHT = 595;

export interface TicketPdfInput {
  eventTitle: string;
  whenLabel: string;
  venue: string;
  ticketType: string;
  holder: string;
  code: string;
  qrPayload: string;
  priceLabel: string;
  orderReference: string;
  index: number;
  total: number;
}

/** Latin-1 fallbacks for the accented characters Slovak actually uses. */
const TRANSLITERATE: Record<string, string> = {
  'ľ': 'l', 'Ľ': 'L', 'š': 's', 'Š': 'S', 'č': 'c', 'Č': 'C', 'ť': 't', 'Ť': 'T',
  'ž': 'z', 'Ž': 'Z', 'ý': 'y', 'Ý': 'Y', 'á': 'a', 'Á': 'A', 'í': 'i', 'Í': 'I',
  'é': 'e', 'É': 'E', 'ú': 'u', 'Ú': 'U', 'ä': 'a', 'Ä': 'A', 'ô': 'o', 'Ô': 'O',
  'ň': 'n', 'Ň': 'N', 'ó': 'o', 'Ó': 'O', 'ĺ': 'l', 'Ĺ': 'L', 'ŕ': 'r', 'Ŕ': 'R',
  'ě': 'e', 'Ě': 'E', 'ř': 'r', 'Ř': 'R', 'ů': 'u', 'Ů': 'U', 'ď': 'd', 'Ď': 'D',
  '€': 'EUR', '·': '-', '—': '-', '–': '-', '„': '"', '“': '"', '”': '"', '’': "'",
};

function latin1(text: string): string {
  let out = '';
  for (const char of text) {
    const mapped = TRANSLITERATE[char];
    if (mapped !== undefined) { out += mapped; continue; }
    out += char.charCodeAt(0) < 256 ? char : '?';
  }
  return out;
}

/** Escapes the three characters that mean something inside a PDF string. */
const pdfString = (text: string) => latin1(text).replace(/([\\()])/g, '\\$1');

function textOp(x: number, y: number, size: number, font: string, value: string): string {
  return `BT /${font} ${size} Tf ${x} ${y} Td (${pdfString(value)}) Tj ET\n`;
}

/** The QR as filled rectangles, drawn from the bottom-left origin PDF uses. */
function qrOps(payload: string, x: number, y: number, boxSize: number): string {
  const modules = encodeQr(payload);
  const n = modules.length;
  const module = boxSize / n;
  // The white margin is not decoration: the specification requires four clear
  // modules on every side, and a scanner that cannot find the quiet zone does
  // not fail gracefully — it simply never sees the code.
  const quiet = module * 4;
  let ops = `1 1 1 rg ${x - quiet} ${y - quiet} ${boxSize + quiet * 2} ${boxSize + quiet * 2} re f\n0 0 0 rg\n`;

  for (let r = 0; r < n; r++) {
    let run = 0;
    for (let c = 0; c <= n; c++) {
      if (c < n && modules[r][c]) { run++; continue; }
      if (run > 0) {
        const px = x + (c - run) * module;
        // PDF's y grows upward, the matrix's r grows downward.
        const py = y + (n - 1 - r) * module;
        ops += `${px.toFixed(2)} ${py.toFixed(2)} ${(run * module).toFixed(2)} ${module.toFixed(2)} re f\n`;
      }
      run = 0;
    }
  }
  return ops;
}

function pageContent(ticket: TicketPdfInput): string {
  const qrBox = 240;
  const qrX = (PAGE_WIDTH - qrBox) / 2;
  const qrY = 230;

  let ops = '';
  // header band
  ops += `0.04 0.05 0.07 rg 0 ${PAGE_HEIGHT - 90} ${PAGE_WIDTH} 90 re f\n`;
  ops += '1 1 1 rg\n';
  ops += textOp(40, PAGE_HEIGHT - 52, 26, 'F2', 'Blup.');
  ops += textOp(40, PAGE_HEIGHT - 74, 9, 'F1', 'VSTUPENKA / TICKET');
  ops += `0 0 0 rg\n`;

  ops += textOp(40, PAGE_HEIGHT - 128, 16, 'F2', ticket.eventTitle);
  ops += textOp(40, PAGE_HEIGHT - 150, 11, 'F1', ticket.whenLabel);
  ops += textOp(40, PAGE_HEIGHT - 166, 11, 'F1', ticket.venue);

  ops += qrOps(ticket.qrPayload, qrX, qrY, qrBox);

  ops += textOp(40, 196, 13, 'F3', ticket.code);
  ops += textOp(40, 172, 10, 'F1', `Typ: ${ticket.ticketType}`);
  ops += textOp(40, 156, 10, 'F1', `Drzitel: ${ticket.holder}`);
  ops += textOp(40, 140, 10, 'F1', `Cena: ${ticket.priceLabel}`);
  ops += textOp(40, 124, 10, 'F1', `Objednavka: ${ticket.orderReference}`);
  ops += textOp(40, 108, 10, 'F1', `Vstupenka ${ticket.index} z ${ticket.total}`);

  ops += `0.6 0.6 0.6 RG 40 92 m ${PAGE_WIDTH - 40} 92 l S\n`;
  ops += `0.35 0.35 0.35 rg\n`;
  ops += textOp(40, 72, 8.5, 'F1', 'Kod je jednorazovy. Po nacitani pri vstupe uz neprejde.');
  ops += textOp(40, 60, 8.5, 'F1', 'Vstupenku najdes aj v aplikacii Blup, v sekcii Moje vstupenky.');

  return ops;
}

/** Builds a multi-page PDF, one ticket per page. */
export function ticketPdf(tickets: TicketPdfInput[]): Uint8Array {
  const encoder = new TextEncoder();
  const objects: string[] = [];

  const fontObjects = [
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>',
  ];

  // 1 = catalog, 2 = pages, 3..5 = fonts, then (page, content) per ticket
  const firstPageObj = 6;
  const pageIds = tickets.map((_, i) => firstPageObj + i * 2);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Count ${tickets.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
  objects[3] = fontObjects[0];
  objects[4] = fontObjects[1];
  objects[5] = fontObjects[2];

  tickets.forEach((ticket, i) => {
    const pageId = pageIds[i];
    const contentId = pageId + 1;
    const content = pageContent(ticket);

    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`;
  });

  // --- serialise with a cross-reference table
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];

  for (let id = 1; id < objects.length; id++) {
    offsets[id] = encoder.encode(pdf).length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }

  const xrefOffset = encoder.encode(pdf).length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return encoder.encode(pdf);
}
