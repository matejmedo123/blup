/**
 * The geometry a seating plan is laid out with — no React, no theme, no
 * drawing. Kept apart from the component that draws it so it can be run and
 * checked on its own: see scripts/check-seat-layout.mjs, which lays seats out
 * in sectors shaped the way somebody tapping a plan out on a phone would
 * shape them, and measures whether they come out evenly spaced.
 */

/**
 * A corner of a sector's outline, in fractions of the plan (0..1).
 *
 * Fractions and not points, the same as everything else on a plan, so the
 * shape survives any resize.
 */
export interface ShapePoint { x: number; y: number }

/**
 * Where a sector's name belongs, and how much room it has.
 *
 * The centre of a wedge's bounding box is not inside the wedge — for a corner
 * stand it is out on the pitch, and eleven such labels land on top of each
 * other. So the name goes at the polygon's centroid, and the size it is
 * allowed comes from the polygon's AREA rather than its box: a thin curved
 * stand has a big box and very little room to write in.
 */
export function shapeMetrics(shape: ShapePoint[], bounds: { x: number; y: number; width: number; height: number }) {
  // Centroid of the polygon (the area-weighted one, not the average of the
  // corners — an outline with more points along the outer arc would otherwise
  // drag the label outwards).
  let twice = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < shape.length; i += 1) {
    const a = shape[i];
    const b = shape[(i + 1) % shape.length];
    const cross = a.x * b.y - b.x * a.y;
    twice += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  const area = Math.abs(twice) / 2;
  const centre = Math.abs(twice) < 1e-9
    ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    : { x: cx / (3 * twice), y: cy / (3 * twice) };

  // How wide a label could be if the sector were a rectangle of the same area
  // and the same proportions. Rough, and much closer than the box.
  const ratio = bounds.height > 0 ? bounds.width / bounds.height : 1;
  return {
    /** Fractions of the plan, 0..1. */
    cx: centre.x,
    cy: centre.y,
    roomW: Math.sqrt(Math.max(area, 1e-9) * ratio),
    roomH: Math.sqrt(Math.max(area, 1e-9) / Math.max(ratio, 1e-9)),
  };
}

/**
 * How wide the sector is at a given height, in plan fractions.
 *
 * A stand that narrows towards the pitch does not hold the same number of
 * chairs in every row, and its rows are not the same length either. Laying
 * them out across the bounding box draws them straight through the sloping
 * edge — the seats end up outside the stand they belong to.
 *
 * So a row is laid out across the sector's actual width AT THAT ROW: the
 * horizontal line through it, clipped by the outline. Null when the line
 * misses the shape entirely, which happens at the very top and bottom of a
 * pointed sector.
 */
export function rowExtent(shape: ShapePoint[], y: number): { x0: number; x1: number } | null {
  const crossings: number[] = [];
  for (let i = 0; i < shape.length; i += 1) {
    const a = shape[i];
    const b = shape[(i + 1) % shape.length];
    if ((a.y > y) === (b.y > y)) continue;
    crossings.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
  }
  if (crossings.length < 2) return null;
  return { x0: Math.min(...crossings), x1: Math.max(...crossings) };
}


/**
 * Kde sa obrys delí na dva okraje pásu.
 *
 * Predloha kreslí obrys sama a delí ho presne v polovici bodov: toľko bodov
 * po jednom okraji, toľko isto po druhom. Tam sa nedá nič vylepšiť a nič sa
 * nemení — jej obrysy majú osemnásť alebo tridsaťdva bodov.
 *
 * Človek v editore klepne rohy, kde chce, a na polovici zoznamu nemusí byť
 * koniec okraja. Pri tvare L to delenie padlo doprostred dlhšej strany: jeden
 * okraj vyšiel 0.9 dlhý, druhý 1.6, a rady sa o štyridsať percent rozišli. Pri
 * krátkom, ručne klepnutom obryse sa preto delenie hľadá — berie sa to, pri
 * ktorom sú oba okraje najviac rovnako dlhé, čo je práve to, čo pás znamená.
 */
export function splitOf(shape: ShapePoint[]): number {
  const n = shape.length;
  const half = Math.max(2, Math.floor(n / 2));
  // Dlhý obrys je kreslený nástrojom; ten má delenie v polovici z princípu.
  if (n < 4 || n > 12) return half;

  const span = (chain: ShapePoint[]) => {
    let total = 0;
    for (let i = 1; i < chain.length; i += 1) {
      total += Math.hypot(chain[i].x - chain[i - 1].x, chain[i].y - chain[i - 1].y);
    }
    return total;
  };

  let best = half;
  let bestGap = Infinity;
  for (let k = 2; k <= n - 2; k += 1) {
    const gap = Math.abs(span(shape.slice(0, k)) - span(shape.slice(k)));
    if (gap < bestGap - 1e-12) { bestGap = gap; best = k; }
  }
  return best;
}

/**
 * A sector's outline read as a band, so seats can be laid along it.
 *
 * A stand is a band: two long edges — the one by the pitch and the one at the
 * back — and two short ends. Rows run ALONG it and the row number counts
 * ACROSS it. That is what makes the rows of a side stand run vertically, a
 * corner stand's rows curve, and the front row of a wedge be shorter than the
 * back one — without any of those being special cases.
 *
 * The outline is traced around the perimeter, by the drawing tool and by the
 * presets alike, so its first half is one long edge and its second half is the
 * other, backwards. That is the whole convention.
 *
 * `at(u, v)`: u runs 0..1 along the band, v runs 0..1 across it, 0 being the
 * first half of the outline.
 */
/*
 * One band per outline, not one per seat.
 *
 * `bandOf` measures both edges and every row it is asked for — a few thousand
 * points of work. The layout calls it once per seat, and a stand has three
 * hundred of them, so without this the same measurement was redone until it
 * was the most expensive thing on the screen. The outline is the key: it is
 * the only thing the answer depends on, and it is replaced rather than
 * edited when a sector is redrawn.
 */
const bands = new WeakMap<ShapePoint[], ReturnType<typeof measureBand>>();

export function bandOf(shape: ShapePoint[]) {
  const known = bands.get(shape);
  if (known) return known;
  const made = measureBand(shape);
  bands.set(shape, made);
  return made;
}

function measureBand(shape: ShapePoint[]) {
  const n = shape.length;
  const half = splitOf(shape);
  const front = shape.slice(0, half);
  const back = shape.slice(half).reverse();

  /**
   * An edge of the band, resampled so that equal steps are equal DISTANCE.
   *
   * Walking a polyline by vertex index is not the same as walking it by
   * length: where two points sit close together the walk crawls, where they
   * sit far apart it leaps. Seats laid out that way bunch up and spread out
   * along the row, and because each seat is sized from its own local step,
   * they come out different sizes too — a run of circles with a fat one in
   * the middle. Measuring the edge first and stepping along it by distance
   * fixes both at once.
   */
  const byLength = (chain: ShapePoint[], samples: number): ShapePoint[] => {
    /*
     * Always `samples` long, even when there is nothing to walk.
     *
     * A sector drawn with three taps splits into an edge and a single corner,
     * and a one-point chain used to come back one point long — at which point
     * asking for "somewhere along it" indexed off the front of the array and
     * the whole plan threw. A wedge that runs to a point is an ordinary
     * enough sector; it is the same corner at every step, and saying so here
     * removes the special case everywhere downstream.
     */
    if (chain.length === 0) return Array.from({ length: samples }, () => ({ x: 0.5, y: 0.5 }));
    if (chain.length === 1) return Array.from({ length: samples }, () => chain[0]);

    const run: number[] = [0];
    for (let i = 1; i < chain.length; i += 1) {
      run.push(run[i - 1] + Math.hypot(chain[i].x - chain[i - 1].x, chain[i].y - chain[i - 1].y));
    }
    const total = run[run.length - 1];
    if (total <= 0) return Array.from({ length: samples }, () => chain[0]);

    const out: ShapePoint[] = [];
    let at = 1;
    for (let k = 0; k < samples; k += 1) {
      const want = (k / (samples - 1)) * total;
      while (at < run.length - 1 && run[at] < want) at += 1;
      const span = run[at] - run[at - 1];
      const f = span <= 0 ? 0 : (want - run[at - 1]) / span;
      const a = chain[at - 1];
      const b = chain[at];
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    }
    return out;
  };

  const SAMPLES = 256;
  const f = byLength(front, SAMPLES);
  const b = byLength(back, SAMPLES);

  // Between samples, not snapped to the nearest one: snapping leaves every
  // gap up to half a sample out, which is a 5% wobble in the spacing and shows
  // up as seats that do not quite line up.
  const pick = (chain: ShapePoint[], u: number): ShapePoint => {
    if (chain.length === 1) return chain[0];
    const t = Math.min(1, Math.max(0, u)) * (chain.length - 1);
    const i = Math.max(0, Math.min(chain.length - 2, Math.floor(t)));
    const g = t - i;
    const a = chain[i];
    const c = chain[i + 1] ?? a;
    return { x: a.x + (c.x - a.x) * g, y: a.y + (c.y - a.y) * g };
  };

  /** Straight across from one edge to the other, at the two edges' own pace. */
  const blend = (u: number, v: number): ShapePoint => {
    const a = pick(f, u);
    const c = pick(b, u);
    return { x: a.x + (c.x - a.x) * v, y: a.y + (c.y - a.y) * v };
  };

  /*
   * A row, measured — because blending two edges does not travel evenly.
   *
   * Each edge on its own is walked by distance. A row in the middle of the
   * stand is a blend of the two, and where the edges run in different
   * directions that blend speeds up and slows down along its own length. On
   * a preset, whose two edges are near enough parallel, it is a 1.6% wobble
   * and invisible. On a sector somebody drew by tapping corners — one
   * straight edge against two that meet at an angle — it is a fifth of the
   * spacing, and the seats in a row visibly bunch towards one end.
   *
   * So a row is sampled, measured, and then walked by DISTANCE, which is the
   * treatment the two edges already get. `u` becomes how far along the row
   * you are, which is what every caller already meant by it.
   */
  const rows = new Map<number, { pts: ShapePoint[]; run: number[] }>();
  const rowAt = (v: number) => {
    const key = Math.round(v * 4096);
    const known = rows.get(key);
    if (known) return known;
    const pts: ShapePoint[] = [];
    for (let i = 0; i < 512; i += 1) pts.push(blend(i / 511, v));
    const run: number[] = [0];
    for (let i = 1; i < pts.length; i += 1) {
      run.push(run[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    }
    const made = { pts, run };
    rows.set(key, made);
    return made;
  };

  const at = (u: number, v: number): ShapePoint => {
    const { pts, run } = rowAt(v);
    const total = run[run.length - 1];
    if (total <= 0) return pts[0];
    const want = Math.min(1, Math.max(0, u)) * total;
    let i = 1;
    while (i < run.length - 1 && run[i] < want) i += 1;
    const span = run[i] - run[i - 1];
    const g = span <= 0 ? 0 : (want - run[i - 1]) / span;
    const a = pts[i - 1];
    const c = pts[i];
    return { x: a.x + (c.x - a.x) * g, y: a.y + (c.y - a.y) * g };
  };

  /** How long the line across the stand is at depth v. */
  const lengthAt = (v: number) => {
    const { run } = rowAt(v);
    return run[run.length - 1];
  };

  return { at, lengthAt };
}

/**
 * How big to draw every seat in a sector — one size for all of them.
 *
 * Sized per seat from its own neighbour gap, a stand that narrows comes out as
 * a mix of dots, circles and blobs, which reads as a mistake rather than as a
 * narrowing stand. One size, taken from the tightest row (the front one on a
 * wedge, where the seats are closest together), keeps every seat the same and
 * keeps none of them touching.
 */
export function seatSize(
  shape: ShapePoint[] | null,
  bounds: { x: number; y: number; width: number; height: number },
  rows: number,
  perRow: number,
  planWidth: number,
  planHeight: number,
  /**
   * How many seats row `r` actually has. A wider row holds more of them, not
   * the same ones further apart, so the distance between two neighbours — the
   * one number a seat has to fit into — can only be read off a row together
   * with its own count. Left out, every row is assumed to hold `perRow`.
   */
  seatsInRow?: (row: number) => number,
) {
  const across = Math.max(perRow, 1);
  const down = Math.max(rows, 1);
  const count = (r: number) => Math.max(seatsInRow?.(r) ?? across, 1);

  if (!shape) {
    const cellW = (bounds.width * planWidth) / across;
    const cellH = (bounds.height * planHeight) / down;
    return Math.max(1, Math.min(cellW, cellH) * 0.72);
  }

  const band = bandOf(shape);
  const scaleX = planWidth;
  const scaleY = planHeight;
  const lengthOf = (v: number) => {
    let total = 0;
    let prev = band.at(0, v);
    for (let i = 1; i <= 48; i += 1) {
      const here = band.at(i / 48, v);
      total += Math.hypot((here.x - prev.x) * scaleX, (here.y - prev.y) * scaleY);
      prev = here;
    }
    return total;
  };
  // The tightest row there is, measured against the seats that row holds:
  // one seat has to fit in that gap and every other row has more room.
  let along = Infinity;
  for (let r = 0; r < down; r += 1) {
    along = Math.min(along, lengthOf((r + 0.5) / down) / count(r));
  }

  const mid = band.at(0.5, 0);
  const far = band.at(0.5, 1);
  const deep = Math.hypot((far.x - mid.x) * planWidth, (far.y - mid.y) * planHeight) / down;

  /*
   * One fill factor, not one per direction.
   *
   * Filling 88% of the gap along a row and 74% of the gap across left the
   * seats in a row all but touching while the rows stood well apart —
   * measured in D205, 0.27 units between neighbours against 0.76 between
   * rows. The eye does not read that as "rows": it reads as solid columns
   * with a regular channel cut between them, which is the one thing a
   * seating plan must not look like.
   *
   * With a single factor the two gaps differ only by however much the two
   * spacings themselves differ — here 2.21 along against 2.70 across, so
   * rows sit a little further apart than neighbours do, which is exactly
   * what a seating plan looks like and no longer reads as a gap.
   */
  return Math.max(1, Math.min(along, deep) * 0.72);
}
