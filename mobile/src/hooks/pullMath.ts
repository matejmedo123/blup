/**
 * When a downward drag counts as "pull to refresh", and how far it has come.
 *
 * No imports and no DOM, so the decision can be tested directly — the wiring
 * around it is a handful of listeners, but this is where it can be wrong.
 */
export const PULL_TRIGGER = 72;
export const PULL_MAX = 110;
/** Below this, a finger has not committed to a direction yet. */
export const PULL_SLOP = 12;
/** Drag resists, so it feels like pulling against something. */
export const PULL_RESISTANCE = 0.55;

export interface PullState {
  /** True once the gesture is unmistakably a downward pull. */
  armed: boolean;
  /** How far the indicator should be drawn, in pixels. */
  distance: number;
  /** The gesture is over as a pull — a scroll, or a sideways swipe. */
  abandoned: boolean;
}

export function pullStep(params: {
  /** Was the scroller at its very top when the finger went down? */
  atTop: boolean;
  /** Movement since the finger went down. */
  dx: number;
  dy: number;
  /** Was it already armed by an earlier move in this gesture? */
  armed: boolean;
}): PullState {
  const { atTop, dx, dy, armed } = params;

  // A pull can only begin at the top. Anywhere else this is an ordinary scroll.
  if (!atTop) return { armed: false, distance: 0, abandoned: true };

  if (!armed) {
    // Upward, or mostly sideways: not a pull, and it will not become one.
    if (dy < -PULL_SLOP || Math.abs(dx) > Math.abs(dy)) {
      return { armed: false, distance: 0, abandoned: true };
    }
    // Not far enough yet to say either way.
    if (dy <= PULL_SLOP) return { armed: false, distance: 0, abandoned: false };
  }

  // Pulled back up past the start: still the same gesture, just nothing to show.
  if (dy <= 0) return { armed: true, distance: 0, abandoned: false };

  return {
    armed: true,
    distance: Math.min(PULL_MAX, dy * PULL_RESISTANCE),
    abandoned: false,
  };
}

/** Far enough that letting go should reload. */
export function pullReleased(distance: number): boolean {
  return distance >= PULL_TRIGGER;
}
