import React, { useCallback, useEffect, useRef, useState } from 'react';

// From the shared file, never from './ImageCrop' — on web that specifier
// resolves back to this very module. See imageCropShared.ts.
import { ImageCropContext, type CropRequest } from './imageCropShared';
import { cropRect } from './imageCropMath';
import { colors, radius, spacing, typography } from '@/theme';

export { useImageCrop } from './imageCropShared';

/**
 * The cropper the web build needs and the OS picker does not provide.
 *
 * `allowsEditing` is ignored by expo-image-picker on the web, so a portrait
 * photo arrived portrait and the card it landed on either letterboxed it or
 * stretched it. Everything that has a fixed shape — a 16:9 cover, a round
 * avatar — is cropped here first, and written out at exactly the size asked for
 * rather than whatever the phone happened to take.
 *
 * Drag to move, wheel or pinch to zoom. The frame never moves; the picture does,
 * and it cannot be dragged past its own edges, so the output is always full.
 */
export function ImageCropProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = useState<CropRequest | null>(null);
  const resolver = useRef<((value: string | null) => void) | null>(null);

  const crop = useCallback((next: CropRequest) => {
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve;
      setRequest(next);
    });
  }, []);

  const finish = useCallback((value: string | null) => {
    resolver.current?.(value);
    resolver.current = null;
    setRequest(null);
  }, []);

  return (
    <ImageCropContext.Provider value={{ crop }}>
      {children}
      {request ? <CropModal request={request} onFinish={finish} /> : null}
    </ImageCropContext.Provider>
  );
}

/** How wide the frame is drawn, in CSS pixels. The output size is independent. */
const FRAME_WIDTH = 460;

function CropModal({
  request,
  onFinish,
}: {
  request: CropRequest;
  onFinish: (value: string | null) => void;
}) {
  const [outW, outH] = request.size;
  const frameW = Math.min(FRAME_WIDTH, (globalThis.innerWidth ?? FRAME_WIDTH) - 48);
  const frameH = (frameW * outH) / outW;

  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  // Only drives the cursor. The ref below drives the maths on every move, and
  // reading a ref during render is how a component lies to React about what it
  // rendered.
  const [dragging, setDragging] = useState(false);

  // `scale` 1 means "just covers the frame"; it can never go below that, which
  // is what guarantees there is no empty corner in the result.
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastSpread = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const el = new globalThis.Image();
    el.crossOrigin = 'anonymous';
    el.onload = () => { if (!cancelled) setImage(el); };
    el.onerror = () => { if (!cancelled) setError('Túto fotku sa nepodarilo načítať.'); };
    el.src = request.uri;
    return () => { cancelled = true; };
  }, [request.uri]);

  // Escape backs out, because a modal you cannot leave with the keyboard is a trap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onFinish(null); };
    globalThis.addEventListener?.('keydown', onKey);
    return () => globalThis.removeEventListener?.('keydown', onKey);
  }, [onFinish]);

  // One implementation of where the frame sits, shared with the crop test — see
  // cropRect in imageCropShared.ts.
  //
  // Read here rather than stored back through an effect: zooming out changes
  // what "too far" means, and correcting the stored value afterwards is a
  // second render with the picture briefly in the wrong place.
  const rect = cropRect({
    imageW: image?.width ?? 1,
    imageH: image?.height ?? 1,
    frameW,
    frameH,
    scale,
    offset,
  });
  const { view, drawW, drawH } = rect;

  const zoomTo = (next: number) => setScale(Math.min(6, Math.max(1, next)));

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      drag.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
      setDragging(true);
    } else {
      drag.current = null;
      setDragging(false);
      lastSpread.current = null;
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const spread = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastSpread.current) zoomTo(scale * (spread / lastSpread.current));
      lastSpread.current = spread;
      return;
    }

    const started = drag.current;
    if (!started) return;
    setOffset({
      x: Math.min(rect.maxX, Math.max(-rect.maxX, started.ox + (e.clientX - started.x))),
      y: Math.min(rect.maxY, Math.max(-rect.maxY, started.oy + (e.clientY - started.y))),
    });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) lastSpread.current = null;
    if (pointers.current.size === 0) {
      drag.current = null;
      setDragging(false);
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    zoomTo(scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
  };

  /**
   * Draws the visible part of the picture into a canvas at exactly the size the
   * caller asked for, so a cover is 1920×1080 whatever the phone took.
   */
  const apply = () => {
    if (!image) return;
    setWorking(true);
    try {
      const canvas = globalThis.document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas');

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(image, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, outW, outH);

      onFinish(canvas.toDataURL('image/jpeg', 0.9));
    } catch {
      setError('Orezanie sa nepodarilo. Skús inú fotku.');
      setWorking(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={request.title ?? 'Orezať fotku'}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(5,8,13,0.86)', backdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div style={{
        background: colors.surface, borderRadius: radius.card, padding: spacing.lg,
        maxWidth: frameW + 48, width: '100%', display: 'flex', flexDirection: 'column',
        gap: spacing.md, border: `1px solid ${colors.border}`,
      }}>
        <div style={{ ...(typography.section as object), color: colors.text }}>
          {request.title ?? 'Orezať fotku'}
        </div>

        {error ? (
          <div style={{ color: colors.danger, font: '400 14px/1.4 inherit' }}>{error}</div>
        ) : null}

        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          style={{
            position: 'relative',
            width: frameW, height: frameH,
            margin: '0 auto',
            overflow: 'hidden',
            borderRadius: request.circle ? '50%' : radius.lg,
            background: colors.backgroundElevated,
            cursor: dragging ? 'grabbing' : 'grab',
            touchAction: 'none',
            userSelect: 'none',
          }}
        >
          {image ? (
            <img
              src={request.uri}
              alt=""
              draggable={false}
              style={{
                position: 'absolute',
                left: '50%', top: '50%',
                width: drawW, height: drawH,
                transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px))`,
                pointerEvents: 'none',
              }}
            />
          ) : null}
        </div>

        <input
          type="range"
          min={1}
          max={6}
          step={0.01}
          value={scale}
          onChange={(e) => zoomTo(Number(e.target.value))}
          aria-label="Priblíženie"
          style={{ width: '100%' }}
        />

        <div style={{ ...(typography.metaSm as object), color: colors.textTertiary }}>
          Ťahaj fotku, kolieskom alebo posuvníkom priblíž. Uloží sa {outW}×{outH}.
        </div>

        <div style={{ display: 'flex', gap: spacing.sm, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={() => onFinish(null)}
            style={ghostButton}
          >
            Zrušiť
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={!image || working}
            style={{ ...primaryButton, opacity: !image || working ? 0.5 : 1 }}
          >
            {working ? 'Orezávam…' : 'Použiť'}
          </button>
        </div>
      </div>
    </div>
  );
}

const buttonBase: React.CSSProperties = {
  border: 'none',
  borderRadius: radius.md,
  padding: '12px 18px',
  font: '700 15px/1 inherit',
  cursor: 'pointer',
};

const primaryButton: React.CSSProperties = {
  ...buttonBase,
  background: colors.accent,
  color: colors.accentText,
};

const ghostButton: React.CSSProperties = {
  ...buttonBase,
  background: 'transparent',
  color: colors.textSecondary,
  border: `1px solid ${colors.border}`,
};
