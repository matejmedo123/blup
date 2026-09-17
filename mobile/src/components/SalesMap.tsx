import React from 'react';

import type { CityPoint } from './salesMapShared';

/**
 * Where the buyers are from — on a phone, nowhere.
 *
 * The statistics screen is read at a desk, and a bubble map on a 390 px screen
 * is a cluster of overlapping circles nobody can read. The screen shows the
 * ranked list of towns either way, and the list is the part you act on, so this
 * renders nothing rather than an empty grey box that looks like a map that
 * failed to load.
 */
export function SalesMap(_props: { points: CityPoint[]; height?: number }) {
  return null;
}
