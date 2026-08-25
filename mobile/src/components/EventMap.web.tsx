import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { categoryFamilies, colors, emojiFor, familyFor, radius, spacing, typography } from '@/theme';
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
 * Tiles come from CARTO's dark basemap, which is free at small volume and
 * matches the app instead of fighting it. Attribution is rendered because it is
 * a condition of use, not decoration — see WEB.md for what to switch to when
 * the traffic outgrows a courtesy tier.
 */

const TILE_SIZE = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = 18;
const TILE_URL = (x: number, y: number, z: number) =>
  `https://basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`;

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
  const drag = useRef<{ x: number; y: number; centre: Coordinates } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, centre };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const scale = Math.pow(2, zoom);
    const dx = (e.clientX - drag.current.x) / TILE_SIZE;
    const dy = (e.clientY - drag.current.y) / TILE_SIZE;
    const next = {
      latitude: yToLat(latToY(drag.current.centre.latitude, zoom) - dy, zoom),
      longitude: xToLon(lonToX(drag.current.centre.longitude, zoom) - dx, zoom),
    };
    setCentre({
      latitude: Math.max(-85, Math.min(85, next.latitude)),
      longitude: ((next.longitude + 540) % 360) - 180,
    });
  };

  const endDrag = () => {
    if (drag.current) report(centre, zoom);
    drag.current = null;
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
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
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
                // A cluster hands over its first event; tapping again walks the
                // rest, which beats zooming in to separate two pins on one street.
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

        {/* Required by the tile provider's terms — not decoration. */}
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
          © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer"
               style={{ color: colors.textTertiary }}>OpenStreetMap</a>
          {' · '}
          <a href="https://carto.com/attributions" target="_blank" rel="noreferrer"
             style={{ color: colors.textTertiary }}>CARTO</a>
        </div>
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
