/**
 * Web Mercator, and the tile grid that covers a viewport.
 *
 * Pure arithmetic, no React and no DOM, so both the event map and the sales map
 * project the same way — and so it can be tested without a browser. Two maps
 * that place a point differently are worse than one map.
 */

export const TILE_SIZE = 256;
export const MIN_ZOOM = 3;
export const MAX_ZOOM = 19;

export interface Point { latitude: number; longitude: number }

export const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * Math.pow(2, z);

export const latToY = (lat: number, z: number) => {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z);
};

export const xToLon = (x: number, z: number) => (x / Math.pow(2, z)) * 360 - 180;

export const yToLat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

/** The middle of a set of points, and the zoom at which they all fit. */
export function fitPoints(
  points: Point[],
  width: number,
  height: number,
  padding = 48,
): { centre: Point; zoom: number } {
  // Nothing to fit: Slovakia, rather than a guess about where this person is.
  if (points.length === 0) {
    return { centre: { latitude: 48.7, longitude: 19.5 }, zoom: 7 };
  }

  const lats = points.map((p) => p.latitude);
  const lngs = points.map((p) => p.longitude);
  const centre = {
    latitude: (Math.min(...lats) + Math.max(...lats)) / 2,
    longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2,
  };

  if (points.length === 1) return { centre, zoom: 11 };

  // Work down from the closest zoom until the whole span fits inside the box.
  // Cheaper to reason about than solving for it, and it cannot overshoot.
  for (let z = MAX_ZOOM; z >= MIN_ZOOM; z--) {
    const xs = lngs.map((lon) => lonToX(lon, z) * TILE_SIZE);
    const ys = lats.map((lat) => latToY(lat, z) * TILE_SIZE);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    if (spanX <= Math.max(width - padding * 2, 1) && spanY <= Math.max(height - padding * 2, 1)) {
      return { centre, zoom: z };
    }
  }

  return { centre, zoom: MIN_ZOOM };
}

/** Where a point sits inside a viewport centred on `centre` at `zoom`. */
export function projectToViewport(
  point: Point,
  centre: Point,
  zoom: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const centreX = lonToX(centre.longitude, zoom) * TILE_SIZE;
  const centreY = latToY(centre.latitude, zoom) * TILE_SIZE;
  return {
    x: lonToX(point.longitude, zoom) * TILE_SIZE - centreX + width / 2,
    y: latToY(point.latitude, zoom) * TILE_SIZE - centreY + height / 2,
  };
}

/**
 * The tiles needed to cover a viewport, with the pixel offset to draw each at.
 *
 * One tile of overdraw on every side, so panning does not reveal a blank strip
 * before the next tile loads.
 */
export function tilesFor(
  centre: Point,
  zoom: number,
  width: number,
  height: number,
): { x: number; y: number; z: number; left: number; top: number }[] {
  const scale = Math.pow(2, zoom);
  const centreX = lonToX(centre.longitude, zoom);
  const centreY = latToY(centre.latitude, zoom);

  const halfW = width / 2 / TILE_SIZE;
  const halfH = height / 2 / TILE_SIZE;

  const minX = Math.floor(centreX - halfW) - 1;
  const maxX = Math.ceil(centreX + halfW) + 1;
  const minY = Math.max(0, Math.floor(centreY - halfH) - 1);
  const maxY = Math.min(scale - 1, Math.ceil(centreY + halfH) + 1);

  const tiles: { x: number; y: number; z: number; left: number; top: number }[] = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      tiles.push({
        // Wrapped, so panning past the date line shows map rather than nothing.
        x: ((x % scale) + scale) % scale,
        y,
        z: zoom,
        left: (x - centreX) * TILE_SIZE + width / 2,
        top: (y - centreY) * TILE_SIZE + height / 2,
      });
    }
  }
  return tiles;
}

/**
 * The radius of a bubble standing for `value`.
 *
 * Area proportional to the value, not radius: a town with twice the tickets
 * should look twice as big, and scaling the radius linearly would make it look
 * four times as big. This is the single most common way a bubble map lies.
 */
export function bubbleRadius(value: number, max: number, minR = 6, maxR = 34): number {
  if (max <= 0 || value <= 0) return minR;
  return minR + (maxR - minR) * Math.sqrt(value / max);
}
