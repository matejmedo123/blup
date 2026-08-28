import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { categoryFamilies, colors, emojiFor, familyFor, radius, spacing, typography } from '@/theme';
import { env } from '@/lib/env';
import type { Coordinates, EventFeedItem } from '@/types/models';

/**
 * The map, on the web.
 *
 * react-native-maps has no web build, so this draws a slippy map directly:
 * Web Mercator tiles in a grid, markers positioned over them, drag to pan and
 * wheel to zoom. About two hundred lines and no dependency — which matters
 * more than it sounds, because the alternatives (Leaflet, Mapbox GL) each want
 * a stylesheet Metro cannot import and a bundle several times the size of this
 * file.
 *
 * Tiles come from OpenStreetMap, inverted in CSS to match a dark app. That is
 * a compromise, and worth being clear about which parts:
 *
 *   · CARTO's dark basemap is the right look, but it now stamps
 *     "API KEY REQUIRED" across every tile unless a key is in the URL.
 *   · Esri's dark grey canvas needs no key and looked right, but outside its
 *     detailed regions it stops at zoom 16 — over Slovakia, zooming in past a
 *     neighbourhood returned "Map data not yet available" on every tile.
 *   · OpenStreetMap has full detail everywhere and needs no key. It is a light
 *     map, so it is inverted; the result is honest and readable, if not as
 *     considered as a purpose-built dark style.
 *
 * OSM's tiles are a volunteer-funded courtesy. They are the right default
 * because the map works on a fresh clone with nothing configured, and the wrong
 * thing to lean on at scale — point EXPO_PUBLIC_MAP_TILES_URL at a provider you
 * pay before this becomes real traffic. WEB.md has the one-line settings.
 *
 * Attribution is rendered because it is a condition of use, not decoration.
 */

const TILE_SIZE = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = 19;
const DEFAULT_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const DEFAULT_ATTRIBUTION = 'OpenStreetMap';

const TILES_TEMPLATE = env.mapTilesUrl || DEFAULT_TILES;
const LABELS_TEMPLATE = env.mapTilesUrl ? env.mapLabelsUrl : '';
const ATTRIBUTION = env.mapAttribution || (env.mapTilesUrl ? '' : DEFAULT_ATTRIBUTION);

/**
 * Only the built-in light basemap gets inverted. A configured provider is
 * presumably already the style its owner wanted, so inverting it would be
 * vandalism — `EXPO_PUBLIC_MAP_TILES_DARKEN=1` turns it on for one that is not.
 */
const DARKEN = env.mapTilesDarken === '1' || (!env.mapTilesUrl && env.mapTilesDarken !== '0');
const DARK_FILTER = 'invert(1) hue-rotate(180deg) saturate(0.55) brightness(0.86) contrast(1.05)';

const fillTemplate = (template: string, x: number, y: number, z: number) =>
  template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));

const TILE_URL = (x: number, y: number, z: number) => fillTemplate(TILES_TEMPLATE, x, y, z);
const LABEL_URL = (x: number, y: number, z: number) =>
  (LABELS_TEMPLATE ? fillTemplate(LABELS_TEMPLATE, x, y, z) : null);

// --- Web Mercator ------------------------------------------------------------
const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * Math.pow(2, z);

const latToY = (lat: number, z: number) => {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z);
};

const xToLon = (x: number, z: number) => (x / Math.pow(2, z)) * 360 - 180;

const yToLat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

/** A zoom level that fits `radiusM` around the centre into `pxHeight`. */
function zoomForRadius(radiusM: number | undefined, latitude: number, pxHeight: number): number {
  if (!radiusM) return 13;
  const metresPerPixelAtZ0 = (156543.03392 * Math.cos((latitude * Math.PI) / 180));
  const wanted = (radiusM * 2.4) / pxHeight;
  const z = Math.log2(metresPerPixelAtZ0 / wanted);
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z)));
}

export function EventMap({
  events,
  userLocation,
  selectedId,
  onSelect,
  onSelectGroup,
  onDeselect,
  onRegionChange,
  radiusM,
  style,
  interactive = true,
  focus,
}: {
  events: EventFeedItem[];
  userLocation?: Coordinates | null;
  selectedId?: string | null;
  onSelect?: (event: EventFeedItem) => void;
  /**
   * Several events on one pin. Tapping used to hand over the first and walk the
   * rest on further taps, which nobody could guess — two events on a street
   * looked like one. Given this, the caller gets all of them and can list them.
   */
  onSelectGroup?: (events: EventFeedItem[]) => void;
  /** Tapping the map itself, away from any pin. */
  onDeselect?: () => void;
  onRegionChange?: (region: { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number }) => void;
  radiusM?: number;
  style?: object;
  interactive?: boolean;
  /**
   * Put the map here. Used when the address is geocoded: the pin has to
   * visibly move to the street that was just found, otherwise "found it" is a
   * sentence with nothing behind it.
   */
  focus?: Coordinates | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const fallbackCentre = useMemo<Coordinates>(() => {
    if (userLocation) return userLocation;
    if (events[0]) return { latitude: events[0].latitude, longitude: events[0].longitude };
    // No location and no events: show Bratislava rather than pretending to know
    // where this person is.
    return { latitude: 48.1486, longitude: 17.1077 };
  }, [userLocation, events]);

  const [centre, setCentre] = useState<Coordinates>(fallbackCentre);
  const [zoom, setZoom] = useState(13);
  const centred = useRef(false);

  // Re-centre once, when a real position first arrives. After that the map is
  // the user's to move — snapping it back under their hands is maddening.
  useEffect(() => {
    if (centred.current || !userLocation) return;
    centred.current = true;
    setCentre(userLocation);
  }, [userLocation]);

  // A new focus point moves the map there and zooms in to street level. Only
  // when it actually changes — panning away afterwards is the user's business.
  const focusKey = focus ? `${focus.latitude},${focus.longitude}` : null;
  useEffect(() => {
    if (!focus) return;
    centred.current = true;
    setCentre({ latitude: focus.latitude, longitude: focus.longitude });
    setZoom((current) => Math.max(current, 16));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  const reported = useRef(false);
  useEffect(() => {
    if (reported.current || !size.width || !size.height) return;
    reported.current = true;
    report(centre, zoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height]);

  useEffect(() => {
    if (size.height > 0) setZoom(zoomForRadius(radiusM, centre.latitude, size.height));
    // Only when the requested radius changes, not on every pan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [radiusM, size.height]);

  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const report = useCallback((next: Coordinates, z: number) => {
    if (!onRegionChange || !size.width) return;
    const scale = Math.pow(2, z) * TILE_SIZE;
    onRegionChange({
      latitude: next.latitude,
      longitude: next.longitude,
      latitudeDelta: Math.abs(yToLat(latToY(next.latitude, z) + size.height / TILE_SIZE / 2, z) - next.latitude) * 2,
      longitudeDelta: (size.width / scale) * 360,
    });
  }, [onRegionChange, size.width, size.height]);

  // --- panning ---------------------------------------------------------------
  /**
   * A drag moves one CSS transform, not fifty images.
   *
   * Recomputing the centre on every pointer move meant React re-rendered the
   * whole grid, and every tile got a new `left` and `top` — a layout pass for
   * ~50 elements per frame, which is what made dragging stutter on a phone.
   * Now the offset goes straight onto a wrapper's `transform`, which the
   * compositor handles without touching layout, and the centre is committed
   * once when the finger lifts.
   */
  const drag = useRef<{ x: number; y: number; centre: Coordinates } | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const offset = useRef({ x: 0, y: 0 });

  /**
   * Every finger currently on the map.
   *
   * Zooming used to be the mouse wheel and nothing else, so on a phone there
   * was no way to zoom at all — no wheel, and a pinch went to the drag handler
   * as one confused pointer. Two fingers now mean a pinch, and the buttons in
   * the corner mean nobody has to discover the gesture.
   */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  /** The last distance between the two fingers, while both were still down. */
  const lastSpread = useRef(0);

  const paint = (x: number, y: number, scale = 1) => {
    offset.current = { x, y };
    if (layerRef.current) {
      layerRef.current.style.transform =
        `translate3d(${x}px, ${y}px, 0)` + (scale === 1 ? '' : ` scale(${scale})`);
    }
  };

  const spread = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  /** Zoom by whole levels, keeping the map's centre where it is. */
  const applyZoom = (next: number) => {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    if (clamped === zoom) return;
    setZoom(clamped);
    report(centre, clamped);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

    // A pointerup can go missing — a gesture interrupted by the browser, a
    // finger that left through the edge — and a stale entry here would leave
    // the map convinced two fingers are still down, which is a map that never
    // pans again. A new gesture starting from more than two is that state, so
    // it starts clean.
    if (pointers.current.size >= 2) {
      pointers.current.clear();
      pinch.current = null;
      lastSpread.current = 0;
      paint(0, 0);
    }

    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2) {
      // A second finger turns a drag into a pinch. Whatever the first one had
      // moved is committed first, so the map does not jump back.
      endDrag();
      const distance = spread();
      pinch.current = { distance, zoom };
      lastSpread.current = distance;
      return;
    }

    drag.current = { x: e.clientX, y: e.clientY, centre };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    if (pinch.current) {
      const distance = spread();
      if (!distance || !pinch.current.distance) return;
      // Live feedback while the fingers move; the zoom itself lands on release,
      // because the tile grid only knows whole levels.
      lastSpread.current = distance;
      const ratio = Math.min(4, Math.max(0.25, distance / pinch.current.distance));
      paint(0, 0, ratio);
      return;
    }

    if (!drag.current) return;
    paint(e.clientX - drag.current.x, e.clientY - drag.current.y);
  };

  const endDrag = () => {
    const started = drag.current;
    drag.current = null;
    if (!started) return;

    const { x, y } = offset.current;
    paint(0, 0);

    // Nothing moved — a tap, not a drag.
    if (x === 0 && y === 0) return;

    const next = {
      latitude: yToLat(latToY(started.centre.latitude, zoom) - y / TILE_SIZE, zoom),
      longitude: xToLon(lonToX(started.centre.longitude, zoom) - x / TILE_SIZE, zoom),
    };
    const settled = {
      latitude: Math.max(-85, Math.min(85, next.latitude)),
      longitude: ((next.longitude + 540) % 360) - 180,
    };

    setCentre(settled);
    report(settled, zoom);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);

    if (pinch.current) {
      // Fewer than two fingers: the pinch is over. How far apart they ended up
      // decides how many levels it was worth.
      if (pointers.current.size < 2) {
        // Measured from the last frame both fingers were down — by now one of
        // them is gone and the distance between them is meaningless.
        const ratio = lastSpread.current
          ? lastSpread.current / pinch.current.distance
          : 1;
        const target = pinch.current.zoom + Math.round(Math.log2(ratio || 1));

        pinch.current = null;
        lastSpread.current = 0;
        paint(0, 0);
        applyZoom(target);
      }
      return;
    }

    endDrag();
  };

  /** A pointer that leaves or is cancelled is a finger that is no longer there. */
  const onPointerLeave = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId) && !drag.current) return;
    onPointerUp(e);
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom + (e.deltaY < 0 ? 1 : -1)));
    if (next !== zoom) { setZoom(next); report(centre, next); }
  };

  // --- tiles -----------------------------------------------------------------
  const tiles = useMemo(() => {
    if (!size.width || !size.height) return [];

    const scale = Math.pow(2, zoom);
    const centreX = lonToX(centre.longitude, zoom);
    const centreY = latToY(centre.latitude, zoom);
    const halfW = size.width / 2 / TILE_SIZE;
    const halfH = size.height / 2 / TILE_SIZE;

    const out: {
      key: string;
      url: string;
      labels: string | null;
      left: number;
      top: number;
    }[] = [];
    for (let x = Math.floor(centreX - halfW); x <= Math.ceil(centreX + halfW); x++) {
      for (let y = Math.floor(centreY - halfH); y <= Math.ceil(centreY + halfH); y++) {
        if (y < 0 || y >= scale) continue;               // no tiles past the poles
        const wrappedX = ((x % scale) + scale) % scale;  // the world wraps east-west
        out.push({
          key: `${zoom}/${x}/${y}`,
          url: TILE_URL(wrappedX, y, zoom),
          labels: LABEL_URL(wrappedX, y, zoom),
          left: (x - centreX) * TILE_SIZE + size.width / 2,
          top: (y - centreY) * TILE_SIZE + size.height / 2,
        });
      }
    }
    return out;
  }, [centre, zoom, size.width, size.height]);

  const project = useCallback((lat: number, lon: number) => ({
    left: (lonToX(lon, zoom) - lonToX(centre.longitude, zoom)) * TILE_SIZE + size.width / 2,
    top: (latToY(lat, zoom) - latToY(centre.latitude, zoom)) * TILE_SIZE + size.height / 2,
  }), [centre, zoom, size.width, size.height]);

  /**
   * Pins closer together than a pin is wide merge into one.
   *
   * Without this, three events on the same street drew three overlapping
   * bubbles: you could not tell how many there were, and the top one was the
   * only one you could tap. Bucketed by screen position rather than by
   * coordinates, so a cluster splits naturally as you zoom in.
   */
  const clusters = useMemo(() => {
    const CELL = 46;
    const buckets = new Map<string, { key: string; position: { left: number; top: number }; events: EventFeedItem[] }>();

    for (const event of events) {
      const position = project(event.latitude, event.longitude);
      const key = `${Math.round(position.left / CELL)}:${Math.round(position.top / CELL)}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.events.push(event);
      } else {
        buckets.set(key, { key, position, events: [event] });
      }
    }

    return [...buckets.values()];
  }, [events, project]);

  return (
    <View style={[styles.container, style]}>
      <div
        ref={hostRef}
        // A tap that reaches the map itself is a tap away from every pin —
        // pins stopPropagation — so it closes whatever card is open.
        onClick={() => onDeselect?.()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onWheel={onWheel}
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          background: colors.map,
          cursor: interactive ? (drag.current ? 'grabbing' : 'grab') : 'default',
          touchAction: 'none',
        }}
      >
        {/* Everything that moves with the map lives in here, so a drag is one
            transform on one element rather than new coordinates on every tile
            and every pin. */}
        <div
          ref={layerRef}
          style={{ position: 'absolute', inset: 0, willChange: 'transform' }}
        >
        {tiles.map((tile) => (
          <React.Fragment key={tile.key}>
            <img
              src={tile.url}
              alt=""
              draggable={false}
              style={{
                position: 'absolute',
                left: tile.left,
                top: tile.top,
                width: TILE_SIZE,
                height: TILE_SIZE,
                userSelect: 'none',
                pointerEvents: 'none',
                // The tiles only — pins and the location dot keep their colours.
                filter: DARKEN ? DARK_FILTER : undefined,
              }}
            />
            {/* Place names, when the basemap keeps them in their own layer. */}
            {tile.labels ? (
              <img
                src={tile.labels}
                alt=""
                draggable={false}
                style={{
                  position: 'absolute',
                  left: tile.left,
                  top: tile.top,
                  width: TILE_SIZE,
                  height: TILE_SIZE,
                  userSelect: 'none',
                  pointerEvents: 'none',
                  filter: DARKEN ? DARK_FILTER : undefined,
                }}
              />
            ) : null}
          </React.Fragment>
        ))}

        {userLocation ? (
          <div
            style={{
              position: 'absolute',
              ...project(userLocation.latitude, userLocation.longitude),
              width: 16, height: 16, marginLeft: -8, marginTop: -8,
              borderRadius: '50%',
              background: colors.mapUser,
              boxShadow: `0 0 0 6px ${colors.accentSoft}, 0 2px 8px rgba(0,0,0,.6)`,
              pointerEvents: 'none',
            }}
          />
        ) : null}

        {clusters.map((cluster) => {
          const { left, top } = cluster.position;
          const lead = cluster.events[0];
          const active = cluster.events.some((e) => e.id === selectedId);
          const grouped = cluster.events.length > 1;
          const tint = categoryFamilies[familyFor(lead.category)].color;

          return (
            <button
              key={cluster.key}
              type="button"
              onClick={(e) => {
                e.stopPropagation();

                if (grouped && onSelectGroup) {
                  onSelectGroup(cluster.events);
                  return;
                }

                // Without a group handler, tapping walks the pin's events one
                // by one rather than being stuck on the first.
                const index = cluster.events.findIndex((ev) => ev.id === selectedId);
                onSelect?.(cluster.events[(index + 1) % cluster.events.length]);
              }}
              title={grouped
                ? cluster.events.map((ev) => ev.title).join('\n')
                : lead.title}
              style={{
                position: 'absolute',
                left, top,
                transform: 'translate(-50%, -100%)',
                display: 'flex', alignItems: 'center', gap: 6,
                padding: active ? '6px 10px' : '5px 8px',
                borderRadius: 999,
                // The family colour rather than one grey for everything: a
                // glance at the map should separate a music night from a run
                // before any label is read.
                border: `1px solid ${active ? tint : colors.border}`,
                background: active ? tint : colors.surface,
                color: active ? '#fff' : colors.text,
                font: '700 12px/1 system-ui, sans-serif',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                boxShadow: `0 4px 14px rgba(0,0,0,.5)${active ? '' : `, inset 0 0 0 2px ${tint}22`}`,
              }}
            >
              <span aria-hidden>{emojiFor(lead.category)}</span>
              {grouped ? (
                <span style={{ color: active ? '#fff' : tint }}>{cluster.events.length}</span>
              ) : null}
              {active && !grouped ? <span>{lead.title}</span> : null}
            </button>
          );
        })}

        </div>

        {/* Buttons as well as gestures: a pinch is invisible, and on a phone
            there is no wheel at all — which is how the map ended up with no way
            to zoom on the platform most people are using. */}
        {interactive ? (
          <div
            style={{
              position: 'absolute', right: 10, top: 10,
              display: 'flex', flexDirection: 'column', gap: 6,
            }}
          >
            {([['+', 1], ['−', -1]] as const).map(([label, step]) => (
              <button
                key={label}
                type="button"
                aria-label={step > 0 ? 'Priblížiť' : 'Oddialiť'}
                disabled={step > 0 ? zoom >= MAX_ZOOM : zoom <= MIN_ZOOM}
                onClick={(e) => { e.stopPropagation(); applyZoom(zoom + step); }}
                onPointerDown={(e) => e.stopPropagation()}
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  border: `1px solid ${colors.border}`,
                  background: colors.surface,
                  color: colors.text,
                  font: '600 18px/1 system-ui, sans-serif',
                  cursor: 'pointer',
                  opacity: (step > 0 ? zoom >= MAX_ZOOM : zoom <= MIN_ZOOM) ? 0.4 : 1,
                }}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        {/* Required by the tile provider's terms — not decoration. */}
        {ATTRIBUTION ? (
          <div
            style={{
              position: 'absolute', right: 6, bottom: 4,
              font: '400 10px/1.4 system-ui, sans-serif',
              color: colors.textQuaternary,
              background: 'rgba(6,8,11,.55)',
              padding: '2px 6px', borderRadius: 6,
              pointerEvents: 'auto',
            }}
          >
            {/* The text is whatever the provider requires; the link is to the
                data everyone underneath is ultimately using. */}
            © <span style={{ color: colors.textTertiary }}>{ATTRIBUTION}</span>
            {' · '}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer"
               style={{ color: colors.textTertiary }}>licencia</a>
          </div>
        ) : null}
      </div>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    minHeight: 220,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.map,
    borderWidth: 1,
    borderColor: colors.border,
  },
});

// Kept so the module's shape matches the native one for anything importing it.
export const MAP_ATTRIBUTION = 'OpenStreetMap · CARTO';
