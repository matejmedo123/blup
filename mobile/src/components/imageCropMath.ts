/**
 * Where the visible rectangle sits in the source image.
 *
 * No imports, deliberately: the crop sheet uses this to draw and to cut, and
 * `scripts/smoke-crop.mjs` imports this same file from Node. A test carrying
 * its own copy of the maths passes happily while the component is broken, so
 * there is one copy and both read it.
 *
 * `scale` 1 means "just covers the frame". The offset is clamped so the picture
 * can never be dragged off the frame, which is what guarantees the result has no
 * empty edge — the failure this whole sheet exists to prevent.
 */
export interface CropRectInput {
  imageW: number;
  imageH: number;
  frameW: number;
  frameH: number;
  scale: number;
  offset: { x: number; y: number };
}

export interface CropRect {
  /** The offset actually used, after clamping. */
  view: { x: number; y: number };
  /** How far the picture may move before it would leave the frame. */
  maxX: number;
  maxY: number;
  /** Rendered size of the picture at this scale. */
  drawW: number;
  drawH: number;
  /** The source rectangle to copy out. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export function cropRect(params: CropRectInput): CropRect {
  const { imageW, imageH, frameW, frameH, scale, offset } = params;

  const baseFit = Math.max(frameW / imageW, frameH / imageH);
  const perSource = baseFit * scale;

  const drawW = imageW * perSource;
  const drawH = imageH * perSource;

  const maxX = Math.max(0, (drawW - frameW) / 2);
  const maxY = Math.max(0, (drawH - frameH) / 2);
  const view = {
    x: Math.min(maxX, Math.max(-maxX, offset.x)),
    y: Math.min(maxY, Math.max(-maxY, offset.y)),
  };

  const sw = frameW / perSource;
  const sh = frameH / perSource;

  return {
    view,
    maxX,
    maxY,
    drawW,
    drawH,
    sw,
    sh,
    sx: (imageW - sw) / 2 - view.x / perSource,
    sy: (imageH - sh) / 2 - view.y / perSource,
  };
}
