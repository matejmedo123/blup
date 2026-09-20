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
  shape, bounds, planWidth, planHeight, colour, dimmed,
}: {
  shape: ShapePoint[];
  /** Where the sector sits on the plan, in fractions. */
  bounds: { x: number; y: number; width: number; height: number };
  planWidth: number;
  planHeight: number;
  colour: string;
  dimmed?: boolean;
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
          strokeWidth={2}
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
