import React, { useEffect, useMemo, useRef, useState } from 'react';

import { env } from '@/lib/env';
import { formatMoney } from '@/lib/format';
import { colors, radius, spacing, typography } from '@/theme';
import {
  bubbleRadius, fitPoints, projectToViewport, tilesFor, TILE_SIZE,
} from './mapTiles';
import type { CityPoint } from './salesMapShared';

/**
 * Where the tickets were bought from.
 *
 * One bubble per town, its *area* proportional to the tickets sold — the map
 * exists to answer "which city do I advertise in next", and a radius scaled
 * straight off the number would make a town with twice the sales look four
 * times as big.
 *
 * Deliberately not pannable. It is a chart, not a map you explore: it fits
 * every town that bought and stays there, so two readings of the same screen
 * show the same thing.
 *
 * Towns whose coordinates we never resolved are not drawn — they are listed
 * underneath instead, because silently dropping them would understate them.
 */
const CARTO_TILES = `https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?key=${env.cartoKey}`;
const TILES_TEMPLATE = env.mapTilesUrl || CARTO_TILES;
const ATTRIBUTION = env.mapAttribution || (env.mapTilesUrl ? '' : 'OpenStreetMap · CARTO');

const tileUrl = (x: number, y: number, z: number) =>
  TILES_TEMPLATE.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));

export function SalesMap({
  points,
  height = 340,
}: {
  points: CityPoint[];
  height?: number;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    const node = hostRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);

  const located = useMemo(
    () => points.filter((p) => p.latitude != null && p.longitude != null),
    [points],
  );

  const view = useMemo(
    () => fitPoints(
      located.map((p) => ({ latitude: p.latitude!, longitude: p.longitude! })),
      width || 800,
      height,
    ),
    [located, width, height],
  );

  const maxTickets = useMemo(
    () => located.reduce((max, p) => Math.max(max, p.tickets), 0),
    [located],
  );

  const tiles = width > 0 ? tilesFor(view.centre, view.zoom, width, height) : [];

  return (
    <div
      ref={hostRef}
      style={{
        position: 'relative',
        height,
        borderRadius: radius.lg,
        overflow: 'hidden',
        background: colors.surfaceElevated,
        border: `1px solid ${colors.border}`,
      }}
    >
      {tiles.map((tile) => (
        <img
          key={`${tile.z}/${tile.x}/${tile.y}`}
          src={tileUrl(tile.x, tile.y, tile.z)}
          alt=""
          draggable={false}
          style={{
            position: 'absolute',
            left: tile.left,
            top: tile.top,
            width: TILE_SIZE,
            height: TILE_SIZE,
            userSelect: 'none',
          }}
        />
      ))}

      {width > 0 && located.map((point) => {
        const position = projectToViewport(
          { latitude: point.latitude!, longitude: point.longitude! },
          view.centre, view.zoom, width, height,
        );
        const r = bubbleRadius(point.tickets, maxTickets);
        const isHovered = hovered === point.city;

        return (
          <div
            key={point.city}
            onMouseEnter={() => setHovered(point.city)}
            onMouseLeave={() => setHovered((current) => (current === point.city ? null : current))}
            title={`${point.city}: ${point.tickets} vstupeniek`}
            style={{
              position: 'absolute',
              left: position.x - r,
              top: position.y - r,
              width: r * 2,
              height: r * 2,
              borderRadius: '50%',
              background: isHovered ? 'rgba(0,128,255,0.55)' : 'rgba(0,128,255,0.34)',
              border: `1.5px solid ${colors.accent}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'default',
              transition: 'background 120ms',
            }}
          >
            {/* The count inside the bubble, but only where it fits. A number
                spilling out of a small circle is worse than no number. */}
            {r >= 14 ? (
              <span style={{
                color: '#FFFFFF',
                fontFamily: typography.bodyStrong.fontFamily as string,
                fontSize: Math.min(13, r * 0.7),
                pointerEvents: 'none',
              }}>
                {point.tickets}
              </span>
            ) : null}
          </div>
        );
      })}

      {/* What the bubble under the cursor is. */}
      {hovered ? (() => {
        const point = located.find((p) => p.city === hovered);
        if (!point) return null;
        return (
          <div style={{
            position: 'absolute',
            left: spacing.md,
            top: spacing.md,
            background: 'rgba(10,13,18,0.9)',
            border: `1px solid ${colors.border}`,
            borderRadius: radius.md,
            padding: `${spacing.sm}px ${spacing.md}px`,
            color: colors.text,
            fontFamily: typography.body.fontFamily as string,
            fontSize: 13,
            pointerEvents: 'none',
          }}>
            <strong>{point.city}</strong>
            {' · '}
            {point.tickets} {point.tickets === 1 ? 'vstupenka' : 'vstupeniek'}
            {' · '}
            {formatMoney(point.gross_cents, 'EUR')}
          </div>
        );
      })() : null}

      {located.length === 0 ? (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: colors.textSecondary,
          fontFamily: typography.body.fontFamily as string,
          fontSize: 14,
          textAlign: 'center',
          padding: spacing.xl,
        }}>
          Zatiaľ žiadne mesto na zakreslenie. Objaví sa tu hneď, ako niekto kúpi vstupenku.
        </div>
      ) : null}

      {/* A condition of use, not decoration. */}
      {ATTRIBUTION ? (
        <div style={{
          position: 'absolute',
          right: 6,
          bottom: 4,
          color: 'rgba(255,255,255,0.65)',
          fontSize: 10,
          fontFamily: typography.caption.fontFamily as string,
          background: 'rgba(0,0,0,0.35)',
          padding: '1px 6px',
          borderRadius: 4,
        }}>
          {ATTRIBUTION}
        </div>
      ) : null}
    </div>
  );
}
