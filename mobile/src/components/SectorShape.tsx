import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Polygon } from 'react-native-svg';

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
