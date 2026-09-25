import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { wheelZoomStep, IDLE_WHEEL, type WheelState } from './mapZoomMath';
import { categoryFamilies, colors, emojiFor, familyFor, radius, spacing, typography } from '@/theme';
import { useSeed } from '@/hooks/useSeed';
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
 * Tiles come from CARTO's dark basemap, which is what this app is designed to
 * sit on. It needs a key — CARTO stamps "API KEY REQUIRED" across every tile
 * without one — and the key is in `extra.cartoKey`, set from
 * EXPO_PUBLIC_CARTO_KEY at build time. A basemap key ends up in the JavaScript
 * the browser downloads whatever anyone does about it; restricting it to the
 * site's own domain in CARTO's dashboard is what protects it, not secrecy.
 *
 * There is no second basemap. Two were tried and both are gone: Esri's dark
 * canvas has no tiles past zoom 16 over Slovakia, and OpenStreetMap inverted in
 * CSS was a stand-in for having no key. Keeping either as a fallback meant the
 * map could quietly come up looking wrong — and then nobody could tell whether
 * they were looking at a bad deploy or a bad setting. One basemap, so a map
 * that looks wrong is a deploy that did not land.
 *
 * EXPO_PUBLIC_MAP_TILES_URL still overrides it, for a provider of your own.
 *
 * Attribution is rendered because it is a condition of use, not decoration.
 */

const TILE_SIZE = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = 19;
const CARTO_TILES = `https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?key=${env.cartoKey}`;

const TILES_TEMPLATE = env.mapTilesUrl || CARTO_TILES;
const ATTRIBUTION = env.mapAttribution || (env.mapTilesUrl ? '' : 'OpenStreetMap · CARTO');

const TILE_URL = (x: number, y: number, z: number) =>
  TILES_TEMPLATE
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));

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

  // Declared before the effects that call it. It used to sit below them, which
  // worked only because an effect runs after the whole component body — a
  // `const` referenced before its own declaration, one reordering away from a
  // temporal-dead-zone crash.
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

  // A new focus point moves the map there and zooms in to street level. Only
  // when it actually changes — panning away afterwards is the user's business.
  const focusKey = focus ? `${focus.latitude},${focus.longitude}` : null;
  useSeed(focusKey, () => {
    if (!focus) return;
    centred.current = true;
    setCentre({ latitude: focus.latitude, longitude: focus.longitude });
    setZoom((current) => Math.max(current, 16));
  });

  /**
   * Tell the app what is on screen — whenever that changes, not once.
   *
   * It used to report exactly one time, the moment the size was first measured.
   * The trouble is what happens immediately afterwards: `fitKey` below sets the
   * zoom to whatever fits `radiusM`, and `focusKey` above sets it to 16. Both
   * run after that single report, so the app was told about the view the map
   * had for one frame and never about the view it settled into.
   *
   * The consequence was events that are plainly on screen and have no pin: the
   * map was showing fifty kilometres while the query had been told to fetch
   * two, and nothing corrected it until the next pan. Reporting from the state
   * itself means every way of moving the map — fit, focus, wheel, pinch, drag —
   * goes through one place and none of them can forget.
   *
   * A drag does not spam this: the centre is committed once, when the finger
   * lifts, and the transform does the moving in between.
   */
  useEffect(() => {
    if (!size.width || !size.height) return;
    report(centre, zoom);
  }, [centre, zoom, size.width, size.height, report]);

  // Only when the requested radius (or the box it has to fit) changes, never on
  // a pan — so it is keyed on exactly those two and adjusts during render
  // rather than a frame later, which is what made the map visibly settle.
  const fitKey = size.height > 0 ? `${radiusM}@${size.height}` : null;
  useSeed(fitKey, () => setZoom(zoomForRadius(radiusM, centre.latitude, size.height)));

  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

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
  const [dragging, setDragging] = useState(false);
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
  };

  /**
   * Put the layer back once the new positions are on screen.
   *
   * Resetting the transform at the moment the finger lifts was a frame of the
   * map snapping back to where the drag started: the transform is a DOM write
   * and happens at once, while the new centre is React state and lands a frame
   * or two later, so for that gap the tiles still sat at the old position with
   * no offset on them. That gap is the flicker. A layout effect runs after the
   * commit that moves the tiles and before the browser paints, so there is no
   * frame where the two disagree.
   */
  useLayoutEffect(() => {
    paint(0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centre, zoom]);

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
    // The ref drives the maths on every pointer move; this only drives the
    // cursor, and reading a ref during render to decide it is exactly the thing
    // that makes a component render differently than React thinks it did.
    setDragging(true);
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
    setDragging(false);
    if (!started) return;

    const { x, y } = offset.current;

    // Nothing moved — a tap, not a drag.
    if (x === 0 && y === 0) {
      paint(0, 0);
      return;
    }

    const next = {
      latitude: yToLat(latToY(started.centre.latitude, zoom) - y / TILE_SIZE, zoom),
      longitude: xToLon(lonToX(started.centre.longitude, zoom) - x / TILE_SIZE, zoom),
    };
    const settled = {
      latitude: Math.max(-85, Math.min(85, next.latitude)),
      longitude: ((next.longitude + 540) % 360) - 180,
    };

    // No report here: setCentre is what the effect above watches, so the drag
    // is announced once the new centre is committed. Calling it by hand as well
    // only sent the same region twice.
    setCentre(settled);
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
        const changing = target !== zoom
          && target >= MIN_ZOOM && target <= MAX_ZOOM;

        pinch.current = null;
        lastSpread.current = 0;
        // If the zoom is not going to change there is no re-render coming, so
        // nothing else will put the scale back.
        if (!changing) paint(0, 0);
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

  /**
   * How much wheel has been turned since the last zoom step.
   *
   * It has to be accumulated. A classic mouse sends one big event per notch,
   * but a trackpad — and any mouse with smooth scrolling — sends a stream of
   * small ones, dozens per flick. Stepping a whole zoom level on each event
   * meant one gentle swipe fell through five or six levels and the map shot
   * out to the whole of Europe. From the hand it reads as the map being
   * violently oversensitive; it was really counting every twitch as a notch.
   */
  const wheelSteps = useRef<WheelState>(IDLE_WHEEL);

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!interactive) return;

    // deltaMode says what the number means: 0 pixels, 1 lines, 2 pages. A line
    // is about 16 pixels and a page about a screen; without this a trackpad
    // (pixels) and a mouse (lines) are off by a factor of sixteen.
    // How many levels this event is worth lives in mapZoomMath, so
    // scripts/check-map-zoom.mjs can ask the same question this does.
    const step = wheelZoomStep(e.deltaY, e.deltaMode, wheelSteps.current, Date.now());
    wheelSteps.current = step.state;
    if (step.levels === 0) return;

    // Functional, because a flick delivers several wheel events before React
    // re-renders. Reading `zoom` from this closure meant each of them computed
    // the same "current + 1" from the same stale number, so a burst of six
    // events still moved exactly one level.
    setZoom((current) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current + step.levels)));
  };

  // --- tiles -----------------------------------------------------------------
  const tiles = useMemo(() => {
    if (!size.width || !size.height) return [];

    const scale = Math.pow(2, zoom);
    const centreX = lonToX(centre.longitude, zoom);
    const centreY = latToY(centre.latitude, zoom);
    const halfW = size.width / 2 / TILE_SIZE;
    const halfH = size.height / 2 / TILE_SIZE;

    const out: { key: string; url: string; left: number; top: number }[] = [];
    for (let x = Math.floor(centreX - halfW); x <= Math.ceil(centreX + halfW); x++) {
      for (let y = Math.floor(centreY - halfH); y <= Math.ceil(centreY + halfH); y++) {
        if (y < 0 || y >= scale) continue;               // no tiles past the poles
        const wrappedX = ((x % scale) + scale) % scale;  // the world wraps east-west
        out.push({
          key: `${zoom}/${x}/${y}`,
          url: TILE_URL(wrappedX, y, zoom),
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
   * only one you could tap.
   *
   * Measured by distance, not by a grid. Bucketing by `round(x / cell)` was
   * cheaper and wrong at the edges: two pins four pixels apart but either side
   * of a cell boundary landed in different buckets and were drawn on top of
   * each other — one pin covering another, which is the thing this exists to
   * prevent. Comparing against the clusters already made costs nothing at this
   * many events and has no boundaries to fall between.
   */
  const clusters = useMemo(() => {
    // A pin is about 54px wide with the count on it; merge anything that would
    // overlap, plus a little room so two do not sit edge to edge.
    const MERGE_WITHIN = 60;
    const made: { key: string; position: { left: number; top: number }; events: EventFeedItem[] }[] = [];

    // Sorted so the same events always cluster the same way, whatever order
    // the feed returned them in — otherwise a refetch could reshuffle the pins.
    const ordered = [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    for (const event of ordered) {
      const position = project(event.latitude, event.longitude);

      const near = made.find((cluster) =>
        Math.hypot(cluster.position.left - position.left, cluster.position.top - position.top)
          < MERGE_WITHIN);

      if (near) {
        near.events.push(event);
      } else {
        made.push({ key: event.id, position, events: [event] });
      }
    }

    return made;
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
          cursor: interactive ? (dragging ? 'grabbing' : 'grab') : 'default',
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
          <img
            key={tile.key}
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
            }}
          />
        ))}

        {userLocation ? (
          <div
            style={{
              position: 'absolute',
              ...project(userLocation.latitude, userLocation.longitude),
              width: 16, height: 16, marginLeft: -8, marginTop: -8,
              borderRadius: '50%',
              // White with a blue halo now that the event pins are blue —
              // otherwise "you are here" was the same colour as everything
              // else on the map and stopped meaning anything.
              background: '#fff',
              boxShadow: `0 0 0 4px ${colors.mapUser}, 0 0 0 9px ${colors.accentSoft},`
                + ` 0 2px 8px rgba(0,0,0,.6)`,
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
                // BLUP's own blue, not the near-black surface: a dark pill on a
                // dark basemap read as a hole in the map rather than as a thing
                // to tap. The category still comes through the emoji, and a
                // hairline of the family colour keeps a glance at the map able
                // to separate a music night from a run.
                border: `1px solid ${active ? '#fff' : tint}`,
                background: active ? colors.accentHover : colors.accent,
                color: '#fff',
                font: '700 12px/1 system-ui, sans-serif',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                boxShadow: `0 4px 14px rgba(0,0,0,.5)${
                  active ? ', 0 0 0 3px rgba(255,255,255,.28)' : ''
                }`,
              }}
            >
              <span aria-hidden>{emojiFor(lead.category)}</span>
              {grouped ? <span>{cluster.events.length}</span> : null}
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
