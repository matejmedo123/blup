import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { colors } from '@/theme';
import type { Seat } from '@/api/seating';

/**
 * A sector's seats, as ONE drawing rather than hundreds of views.
 *
 * Laid out as separate views, every seat is its own box that the browser
 * rounds to whole device pixels — its size AND its position, independently.
 * At a seat two pixels across that turned one stand into a mixture of
 * capsules and specks; sized up so a row reads as a row, it turned into
 * clumps, because a rounding of half a pixel either way is the difference
 * between two seats touching and not.
 *
 * In one SVG the circles carry exact coordinates and the vector rasteriser
 * places them. Nothing rounds, so the rows come out even at any zoom — and a
 * stand of three hundred seats is one element instead of three hundred.
 *
 * Each circle keeps the seat's id, so the plan's own pointer handler still
 * finds it, taps still land on the seat underneath, and it carries the same
 * spoken label the seat had when it was a button — a drawing is still allowed
 * to be read out.
 */
export interface SeatDot { seat: Seat; x: number; y: number }

export function SeatField({
  seats, width, height, radius, onPressSeat, labelFor, dim,
}: {
  /** Positions in the sector's own coordinates, in points. */
  seats: SeatDot[];
  width: number;
  height: number;
  radius: number;
  onPressSeat: (seat: Seat) => void;
  labelFor: (seat: Seat) => string;
  /** Another sector has the floor: still readable, no longer competing. */
  dim?: boolean;
}) {
  if (seats.length === 0) return null;

  return (
    <View style={[StyleSheet.absoluteFill, dim ? styles.quiet : null]}>
      <Svg width={width} height={height}>
        {seats.map(({ seat, x, y }) => (
          <Circle
            key={seat.id}
            id={`seat-${seat.id}`}
            cx={x}
            cy={y}
            r={radius}
            fill={fillFor(seat)}
            accessibilityLabel={labelFor(seat)}
            onPress={() => onPressSeat(seat)}
          />
        ))}
      </Svg>
    </View>
  );
}

/**
 * Filled, never outlined: an outline cannot be thinner than the plan's own
 * unit, so at any real zoom it was half the seat and what you saw was a ring.
 */
function fillFor(seat: Seat): string {
  if (seat.mine_claim === 'held') return colors.accent;
  if (seat.mine) return colors.success;
  if (seat.taken) return 'rgba(120,132,150,0.45)';
  if (!seat.sellable) return 'rgba(120,132,150,0.22)';
  if (seat.kind !== 'standard') return colors.warning;
  return 'rgba(198,207,219,0.92)';
}

const styles = StyleSheet.create({
  quiet: { opacity: 0.3 },
});
