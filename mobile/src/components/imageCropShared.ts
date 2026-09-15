import { createContext, useContext } from 'react';

/**
 * The context and types behind `ImageCrop`, kept in a file of their own.
 *
 * They cannot live in `ImageCrop.tsx`, because `ImageCrop.web.tsx` would then
 * have to `import from './ImageCrop'` — and Metro resolves that specifier on
 * web straight back to `ImageCrop.web.tsx` itself. The module imports itself,
 * the context is undefined at the moment it is read, and every screen renders
 * the error boundary with "Cannot read properties of undefined (reading
 * 'Provider')".
 *
 * Same family as `tags.ts` shadowing `tags.web.tsx`: on a platform-suffixed
 * pair, anything both halves need belongs in a third file whose name is not
 * part of the pair.
 */
export interface CropRequest {
  uri: string;
  /** Output shape and size, e.g. [1920, 1080] for a cover. */
  size: [number, number];
  /** Drawn round, for an avatar. Only changes the preview, not the file. */
  circle?: boolean;
  title?: string;
}

export interface ImageCropValue {
  /** Resolves with a cropped image, or null when the person backs out. */
  crop: (request: CropRequest) => Promise<string | null>;
}

export const ImageCropContext = createContext<ImageCropValue>({
  crop: async (request) => request.uri,
});

export function useImageCrop(): ImageCropValue {
  return useContext(ImageCropContext);
}
