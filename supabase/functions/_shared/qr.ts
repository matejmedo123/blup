/**
 * A QR encoder, because a ticket email without a scannable ticket is half a
 * feature — and because pulling a QR image from a third-party URL would mean
 * handing every ticket's secret to whoever runs that service.
 *
 * Byte mode, error-correction level M, versions 1–10 (up to 213 bytes). The
 * ticket payload `blup://t/{code}/{secret}` is 72 bytes, which lands on
 * version 5. Level M tolerates ~15 % damage: enough for a phone screen with a
 * fingerprint on it or a page printed on a tired office printer.
 *
 * Implements ISO/IEC 18004. Verified module-for-module against a reference
 * encoder in `supabase/functions/_shared/qr.test.md`.
 */

/** Data capacity in bytes for level M, indexed by version (1-based). */
const BYTE_CAPACITY_M = [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

/**
 * Per version at level M: [ecCodewordsPerBlock, group1Blocks, group1DataCodewords,
 * group2Blocks, group2DataCodewords].
 */
const EC_TABLE_M: readonly (readonly number[])[] = [
  [], // unused, versions are 1-based
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
];

/** Row/column centres of the alignment patterns, by version. */
const ALIGNMENT_CENTRES: readonly (readonly number[])[] = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

// --- GF(256) arithmetic, primitive polynomial 0x11D --------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** The generator polynomial for `degree` error-correction codewords. */
function generatorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Reed–Solomon remainder: the error-correction codewords for one block. */
function ecCodewords(data: Uint8Array, count: number): Uint8Array {
  const gen = generatorPoly(count);
  const remainder = new Uint8Array(count);

  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[count - 1] = 0;
    for (let i = 0; i < count; i++) remainder[i] ^= mul(gen[i + 1], factor);
  }
  return remainder;
}

// --- bit stream --------------------------------------------------------------
class BitBuffer {
  private bits: number[] = [];

  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  get length(): number { return this.bits.length; }

  /** Pads to a byte boundary and returns the codewords. */
  toBytes(): Uint8Array {
    while (this.bits.length % 8 !== 0) this.bits.push(0);
    const out = new Uint8Array(this.bits.length / 8);
    for (let i = 0; i < out.length; i++) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | this.bits[i * 8 + j];
      out[i] = byte;
    }
    return out;
  }
}

// --- format & version information -------------------------------------------
/** 15-bit format information: level M is 00, then the mask, then BCH(15,5). */
function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask;
  let rest = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rest >>> i) & 1) rest ^= 0b10100110111 << (i - 10);
  }
  return ((data << 10) | rest) ^ 0b101010000010010;
}

/**
 * 18-bit version information, present from version 7 up: the 6-bit version
 * followed by a BCH(18,6) remainder under the generator
 * x^12+x^11+x^10+x^9+x^8+x^5+x^2+1.
 */
function versionBits(version: number): number {
  let rest = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((rest >>> i) & 1) rest ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | rest;
}

// --- matrix ------------------------------------------------------------------
type Grid = { modules: (boolean | null)[][]; reserved: boolean[][]; size: number };

function blankGrid(size: number): Grid {
  return {
    size,
    modules: Array.from({ length: size }, () => Array<boolean | null>(size).fill(null)),
    reserved: Array.from({ length: size }, () => Array<boolean>(size).fill(false)),
  };
}

function place(grid: Grid, row: number, col: number, dark: boolean, reserve = true): void {
  grid.modules[row][col] = dark;
  if (reserve) grid.reserved[row][col] = true;
}

function drawFinder(grid: Grid, row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= grid.size || cc < 0 || cc >= grid.size) continue;
      const inner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      const ring = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6);
      place(grid, rr, cc, inner || ring);
    }
  }
}

function drawAlignment(grid: Grid, version: number): void {
  const centres = ALIGNMENT_CENTRES[version];
  for (const row of centres) {
    for (const col of centres) {
      // The three finder corners have no alignment pattern.
      const atFinder =
        (row === 6 && col === 6) ||
        (row === 6 && col === grid.size - 7) ||
        (row === grid.size - 7 && col === 6);
      if (atFinder) continue;

      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          place(grid, row + r, col + c, dark);
        }
      }
    }
  }
}

function drawTiming(grid: Grid): void {
  for (let i = 8; i < grid.size - 8; i++) {
    const dark = i % 2 === 0;
    place(grid, 6, i, dark);
    place(grid, i, 6, dark);
  }
}

function reserveFormat(grid: Grid, version: number): void {
  for (let i = 0; i < 9; i++) {
    if (grid.modules[8][i] === null) place(grid, 8, i, false);
    if (grid.modules[i][8] === null) place(grid, i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    place(grid, 8, grid.size - 1 - i, false);
    place(grid, grid.size - 1 - i, 8, false);
  }
  // The one module that is always dark.
  place(grid, grid.size - 8, 8, true);

  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3);
      const c = i % 3;
      place(grid, r, grid.size - 11 + c, false);
      place(grid, grid.size - 11 + c, r, false);
    }
  }
}

/**
 * The 15 format bits are written twice: once down column 8 and along row 8 by
 * the top-left finder, once split between the other two finders. Both copies
 * skip the timing row and column, which is why the index mapping has holes in
 * it rather than running straight through.
 */
function writeFormat(grid: Grid, mask: number): void {
  const bits = formatBits(mask);
  const size = grid.size;

  for (let i = 0; i < 15; i++) {
    const dark = ((bits >>> i) & 1) === 1;

    // Column 8: rows 0–5, then 7–8 (row 6 is timing), then the bottom strip.
    if (i < 6) grid.modules[i][8] = dark;
    else if (i < 8) grid.modules[i + 1][8] = dark;
    else grid.modules[size - 15 + i][8] = dark;

    // Row 8: the right-hand strip, then column 7, then columns 5–0.
    if (i < 8) grid.modules[8][size - 1 - i] = dark;
    else if (i === 8) grid.modules[8][7] = dark;
    else grid.modules[8][14 - i] = dark;
  }

  // The module that is dark in every symbol ever printed.
  grid.modules[size - 8][8] = true;
}

function writeVersion(grid: Grid, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    grid.modules[r][grid.size - 11 + c] = dark;
    grid.modules[grid.size - 11 + c][r] = dark;
  }
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Places the data bits along the zig-zag, skipping everything reserved. */
function placeData(grid: Grid, data: Uint8Array): void {
  let bit = 0;
  const total = data.length * 8;
  let upward = true;

  for (let right = grid.size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column is skipped entirely

    for (let step = 0; step < grid.size; step++) {
      const row = upward ? grid.size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (grid.reserved[row][col]) continue;
        let dark = false;
        if (bit < total) {
          dark = ((data[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 1;
          bit++;
        }
        grid.modules[row][col] = dark;
      }
    }
    upward = !upward;
  }
}

function penalty(modules: boolean[][]): number {
  const n = modules.length;
  let score = 0;

  // Rule 1: runs of five or more same-coloured modules in a row or column.
  for (const transposed of [false, true]) {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        const prev = transposed ? modules[b - 1][a] : modules[a][b - 1];
        const curr = transposed ? modules[b][a] : modules[a][b];
        if (curr === prev) {
          run++;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }
  }

  // Rule 2: 2×2 blocks of one colour.
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 pattern with four light modules beside it.
  const A = [true, false, true, true, true, false, true, false, false, false, false];
  const B = [false, false, false, false, true, false, true, true, true, false, true];
  const matches = (get: (i: number) => boolean, start: number, pattern: boolean[]) =>
    pattern.every((want, i) => get(start + i) === want);

  for (let a = 0; a < n; a++) {
    for (let b = 0; b + 11 <= n; b++) {
      const row = (i: number) => modules[a][i];
      const col = (i: number) => modules[i][a];
      if (matches(row, b, A) || matches(row, b, B)) score += 40;
      if (matches(col, b, A) || matches(col, b, B)) score += 40;
    }
  }

  // Rule 4: deviation from an even split of dark and light.
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark++;
  const percent = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/**
 * Builds all eight mask candidates for `text`, each with its penalty score.
 * Exported so the mask choice can be checked against a reference implementation
 * rather than trusted — a badly masked symbol still decodes in a lab and fails
 * at a dark venue door, which is the worst kind of bug to ship.
 */
export function maskCandidates(text: string): { mask: number; score: number; modules: boolean[][] }[] {
  const bytes = new TextEncoder().encode(text);

  let version = 0;
  for (let v = 1; v <= 10; v++) {
    if (bytes.length <= BYTE_CAPACITY_M[v]) { version = v; break; }
  }
  if (version === 0) {
    throw new Error(`QR_TOO_LONG: ${bytes.length} bytes exceeds the level-M limit of 213`);
  }

  const [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = EC_TABLE_M[version];
  const totalData = g1Blocks * g1Data + g2Blocks * g2Data;

  // --- bit stream: mode, length, payload, terminator, padding
  const buffer = new BitBuffer();
  buffer.put(0b0100, 4);                                  // byte mode
  buffer.put(bytes.length, version >= 10 ? 16 : 8);
  for (const byte of bytes) buffer.put(byte, 8);
  buffer.put(0, Math.min(4, totalData * 8 - buffer.length));

  let codewords = Array.from(buffer.toBytes());
  const PAD = [0xec, 0x11];
  for (let i = 0; codewords.length < totalData; i++) codewords.push(PAD[i % 2]);

  // --- split into blocks, compute error correction
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (const [count, size] of [[g1Blocks, g1Data], [g2Blocks, g2Data]] as const) {
    for (let i = 0; i < count; i++) {
      const block = codewords.slice(offset, offset + size);
      offset += size;
      dataBlocks.push(block);
      ecBlocks.push(Array.from(ecCodewords(Uint8Array.from(block), ecPerBlock)));
    }
  }

  // --- interleave
  const interleaved: number[] = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) interleaved.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) interleaved.push(block[i]);
  }

  // --- matrix: function patterns, then data, then pick the mask
  const size = version * 4 + 17;
  const base = blankGrid(size);
  drawFinder(base, 0, 0);
  drawFinder(base, 0, size - 7);
  drawFinder(base, size - 7, 0);
  drawAlignment(base, version);
  drawTiming(base);
  reserveFormat(base, version);
  placeData(base, Uint8Array.from(interleaved));

  const candidates: { mask: number; score: number; modules: boolean[][] }[] = [];

  for (let mask = 0; mask < 8; mask++) {
    const grid: Grid = {
      size,
      reserved: base.reserved,
      modules: base.modules.map((row) => row.slice()),
    };
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!grid.reserved[r][c] && MASKS[mask](r, c)) grid.modules[r][c] = !grid.modules[r][c];
      }
    }
    writeFormat(grid, mask);
    writeVersion(grid, version);

    const modules = grid.modules as boolean[][];
    candidates.push({ mask, score: penalty(modules), modules });
  }

  return candidates;
}

/**
 * Encodes `text` and returns the module matrix — `true` is a dark module.
 * The caller decides how to draw it (SVG, PDF, canvas).
 */
export function encodeQr(text: string): boolean[][] {
  const candidates = maskCandidates(text);
  let best = candidates[0];
  for (const candidate of candidates) if (candidate.score < best.score) best = candidate;
  return best.modules;
}

/** The QR as a standalone SVG string, `quiet` modules of margin around it. */
export function qrSvg(text: string, { size = 240, quiet = 4 } = {}): string {
  const modules = encodeQr(text);
  const n = modules.length + quiet * 2;
  const rects: string[] = [];

  for (let r = 0; r < modules.length; r++) {
    let run = 0;
    for (let c = 0; c <= modules[r].length; c++) {
      if (c < modules[r].length && modules[r][c]) { run++; continue; }
      if (run > 0) rects.push(`<rect x="${c - run + quiet}" y="${r + quiet}" width="${run}" height="1"/>`);
      run = 0;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">`
    + `<rect width="${n}" height="${n}" fill="#ffffff"/>`
    + `<g fill="#000000">${rects.join('')}</g></svg>`;
}
