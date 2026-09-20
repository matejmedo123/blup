import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Polygon } from 'react-native-svg';
import { radius } from '@/theme';
import type { ShapePoint } from './seatBand';

// The maths lives next door, in a file with no React in it, so it can be run
// and measured on its own. Re-exported here because this is where every
// caller already looks for it.
export type { ShapePoint } from './seatBand';
export { bandOf, rowExtent, seatSize, shapeMetrics } from './seatBand';

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
