/**
 * A small PDF writer — enough to lay out one ticket per page: the wordmark, the
 * event, the QR drawn as filled squares, and everything a ticket has to say.
 *
 * Why not an HTML email with an inline image: Gmail strips `data:` image URIs,
 * and a remote `<img>` would mean handing every ticket's secret to whoever
 * hosts it. A PDF attachment is the one thing that survives every mail client,
 * prints, and works at a door with no signal.
 *
 * Only WinAnsi (Latin-1) characters exist in the standard fonts, so text is
 * transliterated before it is written — an unaccented event title is worse than
 * an accented one, and far better than a mangled one.
 */
import { encodeQr } from './qr.ts';

const PAGE_WIDTH = 420;   // points — a compact ticket, roughly A6 portrait
const PAGE_HEIGHT = 595;
const MARGIN = 34;
const INNER = PAGE_WIDTH - MARGIN * 2;

export interface TicketPdfInput {
  eventTitle: string;
  whenLabel: string;
  venue: string;
  /** Street address, printed under the venue when it adds anything. */
  address?: string;
  ticketType: string;
  holder: string;
  code: string;
  qrPayload: string;
  priceLabel: string;
  /** e.g. "z toho archívny poplatok 1,00 €" — omitted when there is none. */
  feeLabel?: string;
  orderReference: string;
  issuedLabel: string;
  seller: {
    name: string;
    registrationNumber?: string | null;
    vatNumber?: string | null;
    address?: string | null;
    email?: string | null;
  };
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
  '€': '\x80', '·': '-', '—': '-', '–': '-', '„': '"', '“': '"', '”': '"', '’': "'",
  ' ': ' ',
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

// ---------------------------------------------------------------------------
// Text metrics
// ---------------------------------------------------------------------------
// The standard-14 fonts are not embedded, so the widths have to come from
// somewhere: these are the Adobe AFM values, per 1000 units of em. Without them
// nothing can be centred, right-aligned or wrapped — and a ticket whose title
// runs off the edge of the card is not a ticket anyone wants to be handed.
const HELVETICA: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500,
  K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
  k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '{': 334, '|': 260, '}': 334, '~': 584,
};

const HELVETICA_BOLD: Record<string, number> = {
  ' ': 278, '!': 333, '"': 474, '#': 556, $: 556, '%': 889, '&': 722, "'": 238,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  ':': 333, ';': 333, '<': 584, '=': 584, '>': 584, '?': 611, '@': 975,
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556,
  K: 722, L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 333, '\\': 278, ']': 333, '^': 584, _: 556, '`': 333,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278,
  k: 556, l: 278, m: 889, n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333,
  u: 611, v: 556, w: 778, x: 556, y: 556, z: 500,
  '{': 389, '|': 280, '}': 389, '~': 584,
};

type FontId = 'F1' | 'F2' | 'F3';

function widthOf(text: string, size: number, font: FontId): number {
  const table = font === 'F2' ? HELVETICA_BOLD : font === 'F1' ? HELVETICA : null;
  const source = latin1(text);

  // Courier is monospaced at 600/1000 for every glyph.
  if (!table) return (source.length * 600 * size) / 1000;

  let units = 0;
  for (const char of source) {
    // Digits are 556 in both faces; anything unmapped falls back to that so an
    // unusual glyph shifts the layout slightly rather than breaking it.
    units += table[char] ?? 556;
  }
  return (units * size) / 1000;
}

/** Greedy wrap that never returns more than `maxLines`, eliding the overflow. */
function wrap(text: string, size: number, font: FontId, maxWidth: number, maxLines: number): string[] {
  const words = latin1(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (widthOf(candidate, size, font) <= maxWidth || !line) {
      line = candidate;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }

  if (lines.length < maxLines && line) lines.push(line);

  if (lines.length === maxLines && words.length) {
    // Something may not have fitted; mark it rather than cutting mid-word.
    const rendered = lines.join(' ');
    if (rendered.length < latin1(text).length - 1) {
      let last = lines[maxLines - 1];
      while (last && widthOf(`${last}...`, size, font) > maxWidth) {
        last = last.slice(0, -1);
      }
      lines[maxLines - 1] = `${last}...`;
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Drawing primitives
// ---------------------------------------------------------------------------
const rgb = (r: number, g: number, b: number) => `${r} ${g} ${b} rg\n`;
const stroke = (r: number, g: number, b: number) => `${r} ${g} ${b} RG\n`;

function text(x: number, y: number, size: number, font: FontId, value: string): string {
  return `BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfString(value)}) Tj ET\n`;
}

function textCentre(centre: number, y: number, size: number, font: FontId, value: string): string {
  return text(centre - widthOf(value, size, font) / 2, y, size, font, value);
}

function textRight(right: number, y: number, size: number, font: FontId, value: string): string {
  return text(right - widthOf(value, size, font), y, size, font, value);
}

/** Letter-spaced small caps for the eyebrow labels. */
function textTracked(x: number, y: number, size: number, font: FontId, value: string, track = 1.2): string {
  return `BT /${font} ${size} Tf ${track} Tc ${x.toFixed(2)} ${y.toFixed(2)} Td ` +
         `(${pdfString(value)}) Tj 0 Tc ET\n`;
}

const rect = (x: number, y: number, w: number, h: number) =>
  `${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f\n`;

/** A rounded rectangle, four arcs approximated with the usual 0.5523 handles. */
function roundedRect(x: number, y: number, w: number, h: number, r: number, fill: boolean): string {
  const k = r * 0.5523;
  const x2 = x + w;
  const y2 = y + h;

  return (
    `${(x + r).toFixed(2)} ${y.toFixed(2)} m\n` +
    `${(x2 - r).toFixed(2)} ${y.toFixed(2)} l\n` +
    `${(x2 - r + k).toFixed(2)} ${y.toFixed(2)} ${x2.toFixed(2)} ${(y + r - k).toFixed(2)} ${x2.toFixed(2)} ${(y + r).toFixed(2)} c\n` +
    `${x2.toFixed(2)} ${(y2 - r).toFixed(2)} l\n` +
    `${x2.toFixed(2)} ${(y2 - r + k).toFixed(2)} ${(x2 - r + k).toFixed(2)} ${y2.toFixed(2)} ${(x2 - r).toFixed(2)} ${y2.toFixed(2)} c\n` +
    `${(x + r).toFixed(2)} ${y2.toFixed(2)} l\n` +
    `${(x + r - k).toFixed(2)} ${y2.toFixed(2)} ${x.toFixed(2)} ${(y2 - r + k).toFixed(2)} ${x.toFixed(2)} ${(y2 - r).toFixed(2)} c\n` +
    `${x.toFixed(2)} ${(y + r).toFixed(2)} l\n` +
    `${x.toFixed(2)} ${(y + r - k).toFixed(2)} ${(x + r - k).toFixed(2)} ${y.toFixed(2)} ${(x + r).toFixed(2)} ${y.toFixed(2)} c\n` +
    (fill ? 'f\n' : 'S\n')
  );
}

/** A filled circle — the dot of the wordmark, and the perforation notches. */
function circle(cx: number, cy: number, r: number): string {
  const k = r * 0.5523;
  return (
    `${(cx - r).toFixed(2)} ${cy.toFixed(2)} m\n` +
    `${(cx - r).toFixed(2)} ${(cy + k).toFixed(2)} ${(cx - k).toFixed(2)} ${(cy + r).toFixed(2)} ${cx.toFixed(2)} ${(cy + r).toFixed(2)} c\n` +
    `${(cx + k).toFixed(2)} ${(cy + r).toFixed(2)} ${(cx + r).toFixed(2)} ${(cy + k).toFixed(2)} ${(cx + r).toFixed(2)} ${cy.toFixed(2)} c\n` +
    `${(cx + r).toFixed(2)} ${(cy - k).toFixed(2)} ${(cx + k).toFixed(2)} ${(cy - r).toFixed(2)} ${cx.toFixed(2)} ${(cy - r).toFixed(2)} c\n` +
    `${(cx - k).toFixed(2)} ${(cy - r).toFixed(2)} ${(cx - r).toFixed(2)} ${(cy - k).toFixed(2)} ${(cx - r).toFixed(2)} ${cy.toFixed(2)} c\n` +
    'f\n'
  );
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

  let ops = rgb(1, 1, 1) + rect(x - quiet, y - quiet, boxSize + quiet * 2, boxSize + quiet * 2);
  ops += rgb(0, 0, 0);

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

// ---------------------------------------------------------------------------
// The ticket
// ---------------------------------------------------------------------------
const INK = { r: 0.06, g: 0.07, b: 0.09 };
const ACCENT = { r: 1, g: 0.29, b: 0.42 };   // the BLUP pink
const MUTED = 0.42;

/** The wordmark, drawn rather than imported: "Blup" plus its accent dot. */
function wordmark(x: number, baseline: number, size: number, light: boolean): string {
  const colour = light ? rgb(1, 1, 1) : rgb(INK.r, INK.g, INK.b);
  let ops = colour + text(x, baseline, size, 'F2', 'Blup');
  const dotX = x + widthOf('Blup', size, 'F2') + size * 0.085;
  ops += rgb(ACCENT.r, ACCENT.g, ACCENT.b);
  ops += circle(dotX + size * 0.11, baseline + size * 0.11, size * 0.11);
  return ops;
}

/**
 * A label above a value — the layout the whole ticket is built from. `top` is
 * the baseline of the label; the value follows 13pt below it, and each extra
 * line another 11. Callers budget their own vertical space from that.
 */
function field(
  x: number, top: number, label: string, value: string, width: number, maxLines = 1,
): string {
  let ops = rgb(MUTED, MUTED, MUTED) + textTracked(x, top, 6.5, 'F2', label.toUpperCase());
  ops += rgb(INK.r, INK.g, INK.b);
  const lines = wrap(value, 9.5, 'F1', width, maxLines);
  lines.forEach((line, i) => { ops += text(x, top - 13 - i * 11, 9.5, 'F1', line); });
  return ops;
}

/**
 * The layout, budgeted from the bottom up.
 *
 * A ticket is not a page of flowing text: the footer, the seller block and the
 * stub have fixed places, and what gives is the size of the code panel in the
 * middle. Laying it out top-down is how the first version ended up printing the
 * seller over the terms — so the fixed things are pinned to absolute
 * coordinates here, and the panel takes what is left.
 */
const FOOTER = {
  terms2: 14,
  terms1: 24,
  rule: 36,
  sellerBottom: 44,      // third line of the seller block
  sellerLabel: 78,
  stub2: 108,            // label baseline of the second stub row
  feeNote: 128,          // the fee note, tucked under the price
  stub1: 152,            // label baseline of the first stub row
  perforation: 178,
};

function pageContent(ticket: TicketPdfInput): string {
  let ops = '';

  // --- header band --------------------------------------------------------
  const bandHeight = 88;
  const bandTop = PAGE_HEIGHT - bandHeight;
  ops += rgb(INK.r, INK.g, INK.b) + rect(0, bandTop, PAGE_WIDTH, bandHeight);

  ops += wordmark(MARGIN, PAGE_HEIGHT - 46, 24, true);

  ops += rgb(1, 1, 1);
  ops += textTracked(MARGIN, PAGE_HEIGHT - 66, 7, 'F1', 'ELEKTRONICKA VSTUPENKA', 1.6);

  // The "n of m" chip, so a printed stack stays in order.
  const chipLabel = `${ticket.index}/${ticket.total}`;
  const chipWidth = widthOf(chipLabel, 10, 'F2') + 20;
  ops += rgb(ACCENT.r, ACCENT.g, ACCENT.b);
  ops += roundedRect(PAGE_WIDTH - MARGIN - chipWidth, PAGE_HEIGHT - 52, chipWidth, 22, 11, true);
  ops += rgb(1, 1, 1);
  ops += textCentre(PAGE_WIDTH - MARGIN - chipWidth / 2, PAGE_HEIGHT - 45, 10, 'F2', chipLabel);

  // --- event --------------------------------------------------------------
  let y = bandTop - 30;
  ops += rgb(INK.r, INK.g, INK.b);
  for (const line of wrap(ticket.eventTitle, 17, 'F2', INNER, 2)) {
    ops += text(MARGIN, y, 17, 'F2', line);
    y -= 20;
  }

  y -= 4;
  const column = (INNER - 16) / 2;
  ops += field(MARGIN, y, 'Kedy', ticket.whenLabel, column, 2);
  ops += field(MARGIN + column + 16, y, 'Kde',
    ticket.address ? `${ticket.venue}, ${ticket.address}` : ticket.venue, column, 2);

  // --- the code panel, which takes whatever room is left ------------------
  const cardTop = y - 13 - 11 - 16;             // below a two-line field
  const cardY = FOOTER.perforation + 20;
  const cardHeight = cardTop - cardY;

  ops += rgb(0.97, 0.97, 0.98);
  ops += roundedRect(MARGIN, cardY, INNER, cardHeight, 14, true);

  // 42pt at the bottom of the panel belongs to the code and its caption.
  const qrBox = Math.min(INNER - 96, cardHeight - 62);
  const qrX = PAGE_WIDTH / 2 - qrBox / 2;
  const qrY = cardY + 50;

  // A rounded white plate under the code: the quiet zone has to be white, and a
  // rounded plate is a nicer way to be white than a square with hard corners.
  ops += rgb(1, 1, 1);
  ops += roundedRect(qrX - 16, qrY - 16, qrBox + 32, qrBox + 32, 8, true);
  ops += qrOps(ticket.qrPayload, qrX, qrY, qrBox);

  ops += rgb(INK.r, INK.g, INK.b);
  ops += textCentre(PAGE_WIDTH / 2, cardY + 28, 13, 'F3', ticket.code);
  ops += rgb(MUTED, MUTED, MUTED);
  ops += textCentre(PAGE_WIDTH / 2, cardY + 14, 7, 'F1',
    'Kod je jednorazovy - po nacitani pri vstupe uz neprejde.');

  // --- perforation ---------------------------------------------------------
  const perf = FOOTER.perforation;
  ops += rgb(1, 1, 1) + circle(0, perf, 7) + circle(PAGE_WIDTH, perf, 7);
  ops += stroke(0.8, 0.8, 0.82);
  ops += `[3 3] 0 d 0.8 w ${MARGIN} ${perf} m ${PAGE_WIDTH - MARGIN} ${perf} l S\n[] 0 d\n`;

  // --- the stub ------------------------------------------------------------
  const third = (INNER - 24) / 3;
  ops += field(MARGIN, FOOTER.stub1, 'Drzitel', ticket.holder, third);
  ops += field(MARGIN + third + 12, FOOTER.stub1, 'Typ vstupenky', ticket.ticketType, third);
  ops += field(MARGIN + (third + 12) * 2, FOOTER.stub1, 'Cena', ticket.priceLabel, third);

  // The fee note belongs under the price it is part of, not under the holder's
  // name where it reads as something about them.
  if (ticket.feeLabel) {
    ops += rgb(MUTED, MUTED, MUTED);
    const feeX = MARGIN + (third + 12) * 2;
    wrap(ticket.feeLabel, 6.5, 'F1', third, 2).forEach((entry, i) => {
      ops += text(feeX, FOOTER.feeNote - i * 8, 6.5, 'F1', entry);
    });
  }

  ops += field(MARGIN, FOOTER.stub2, 'Objednavka', ticket.orderReference, column);
  ops += field(MARGIN + column + 16, FOOTER.stub2, 'Vydane', ticket.issuedLabel, column);

  // --- who sold it ---------------------------------------------------------
  // The contract is between the buyer and the organizer; BLUP is where it
  // happened. A ticket that names only the platform is wrong about who owes a
  // refund when an event does not take place.
  const sellerLines = [
    ticket.seller.name,
    [
      ticket.seller.registrationNumber ? `ICO ${ticket.seller.registrationNumber}` : null,
      ticket.seller.vatNumber ? `DIC ${ticket.seller.vatNumber}` : null,
    ].filter(Boolean).join(' - '),
    [ticket.seller.address, ticket.seller.email].filter(Boolean).join(' - '),
  ].filter((line) => line && line.length > 0);

  ops += rgb(MUTED, MUTED, MUTED);
  ops += textTracked(MARGIN, FOOTER.sellerLabel, 6.5, 'F2', 'PREDAJCA');
  ops += textRight(PAGE_WIDTH - MARGIN, FOOTER.sellerLabel, 7, 'F1', 'Vystavene cez BLUP');

  ops += rgb(INK.r, INK.g, INK.b);
  let line = FOOTER.sellerLabel - 12;
  for (const entry of sellerLines.slice(0, 3)) {
    ops += text(MARGIN, line, 7.5, 'F1', wrap(entry, 7.5, 'F1', INNER, 1)[0] ?? entry);
    line -= 10;
    if (line < FOOTER.sellerBottom) break;
  }

  ops += stroke(0.88, 0.88, 0.9);
  ops += `0.8 w ${MARGIN} ${FOOTER.rule} m ${PAGE_WIDTH - MARGIN} ${FOOTER.rule} l S\n`;

  ops += rgb(MUTED, MUTED, MUTED);
  ops += text(MARGIN, FOOTER.terms1, 7, 'F1',
    'Vstupenka plati na jeden vstup a zodpoveda za nu jej drzitel.');
  ops += text(MARGIN, FOOTER.terms2, 7, 'F1',
    'Pri zruseni podujatia vracia peniaze organizator. Vstupenku najdes aj v aplikacii Blup.');

  return ops;
}

/**
 * PDF is a byte format, not a Unicode one: a string in a content stream is a
 * sequence of bytes that the font's encoding — here WinAnsi — gives meaning to.
 * Running the file through a UTF-8 encoder would turn the one byte that means
 * "€" into two that mean "Â€", and would shift every cross-reference offset
 * that follows it. Everything written above is already Latin-1 (see
 * `latin1()`), so one byte per code unit is exactly right.
 */
function latin1Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

/** Builds a multi-page PDF, one ticket per page. */
export function ticketPdf(tickets: TicketPdfInput[]): Uint8Array {
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
    objects[contentId] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });

  // --- serialise with a cross-reference table
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];

  // One byte per code unit, so `pdf.length` is the byte offset — which is what
  // the cross-reference table has to contain.
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return latin1Bytes(pdf);
}
