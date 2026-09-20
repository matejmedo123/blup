import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Polygon } from 'react-native-svg';
import { radius } from '@/theme';

/**
 * A sector that is not a rectangle.
 *
 * A stand in the corner of a stadium curves; a terrace behind a goal is a
 * trapezium; a balcony is an arc. Drawn as a rectangle, each of those either
 * covers part of the pitch or leaves part of itself outside — and somebody
 * buying a seat is using that picture to work out where they will be sitting.
 *
 * The points are fractions of the plan (0..1), the same as everything else, so
 * the shape survives any resize. They are converted to the sector's own box
 * here, because that is what both plans lay out with.
 */
export interface ShapePoint { x: number; y: number }

export function SectorShape({
  shape, bounds, planWidth, planHeight, colour, dimmed, strokeWidth = 2,
}: {
  shape: ShapePoint[];
  /** Where the sector sits on the plan, in fractions. */
  bounds: { x: number; y: number; width: number; height: number };
  planWidth: number;
  planHeight: number;
  colour: string;
  dimmed?: boolean;
  /**
   * In the plan's own units, so it scales with the zoom. Pass 2 / scale to
   * keep it a hairline however far in the plan is — at eight times in, a
   * 2-unit outline is 16 points thick and the stand is mostly outline.
   */
  strokeWidth?: number;
}) {
  const width = Math.max(bounds.width * planWidth, 1);
  const height = Math.max(bounds.height * planHeight, 1);

  // Relative to the sector's own top-left, so the SVG only has to be as big as
  // the sector rather than as big as the plan.
  const points = shape
    .map((point) => {
      const x = ((point.x - bounds.x) / Math.max(bounds.width, 0.0001)) * width;
      const y = ((point.y - bounds.y) / Math.max(bounds.height, 0.0001)) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Svg width={width} height={height}>
        <Polygon
          points={points}
          fill={dimmed ? 'rgba(255,255,255,0.04)' : `${colour}33`}
          stroke={dimmed ? 'rgba(255,255,255,0.18)' : colour}
          strokeWidth={strokeWidth}
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}

/**
 * How to letter a sector box that may be 27 pixels wide.
 *
 * A stadium is not five big rectangles — it is sixty small ones called A101
 * and B204, and those names are the whole point: they are what is printed on
 * the ticket. At a fixed 12px "A101" does not fit in its stand and comes out
 * as "A…", which names nothing. So the label is sized from the box it has to
 * live in, and the corner radius is clamped too — `radius.sm` on a box this
 * small turns a stand into a pill.
 */
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

export function sectorLabelStyle(width: number, height: number) {
  const fits = Math.min(width / Math.max(1, 4.2), height * 0.62);
  return {
    fontSize: Math.max(6, Math.min(12, fits)),
    lineHeight: Math.max(7, Math.min(14, fits * 1.15)),
  };
}

export function sectorRadius(width: number, height: number) {
  return Math.max(2, Math.min(radius.sm, Math.min(width, height) / 4));
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
export function bandOf(shape: ShapePoint[]) {
  const n = shape.length;
  const half = Math.max(2, Math.floor(n / 2));
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
    if (chain.length === 0) return [{ x: 0.5, y: 0.5 }];
    if (chain.length === 1) return [chain[0]];

    const run: number[] = [0];
    for (let i = 1; i < chain.length; i += 1) {
      run.push(run[i - 1] + Math.hypot(chain[i].x - chain[i - 1].x, chain[i].y - chain[i - 1].y));
    }
    const total = run[run.length - 1];
    if (total <= 0) return [chain[0]];

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
    const t = Math.min(1, Math.max(0, u)) * (chain.length - 1);
    const i = Math.min(chain.length - 2, Math.floor(t));
    const g = t - i;
    const a = chain[i];
    const c = chain[i + 1] ?? a;
    return { x: a.x + (c.x - a.x) * g, y: a.y + (c.y - a.y) * g };
  };

  return {
    at(u: number, v: number): ShapePoint {
      const a = pick(f, u);
      const c = pick(b, u);
      return { x: a.x + (c.x - a.x) * v, y: a.y + (c.y - a.y) * v };
    },
  };
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
) {
  const across = Math.max(perRow, 1);
  const down = Math.max(rows, 1);

  if (!shape) {
    const cellW = (bounds.width * planWidth) / across;
    const cellH = (bounds.height * planHeight) / down;
    return Math.max(1, Math.min(cellW * 0.82, cellH * 0.78));
  }

  const band = bandOf(shape);
  const span = (v: number) => {
    const a = band.at(0, v);
    const b = band.at(1, v);
    return Math.hypot((b.x - a.x) * planWidth, (b.y - a.y) * planHeight);
  };
  // Both edges, because either can be the short one.
  const along = Math.min(span(0), span(1)) / across;

  const mid = band.at(0.5, 0);
  const far = band.at(0.5, 1);
  const deep = Math.hypot((far.x - mid.x) * planWidth, (far.y - mid.y) * planHeight) / down;

  return Math.max(1, Math.min(along * 0.8, deep * 0.78));
}
