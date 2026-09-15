import React from 'react';

export { useImageCrop, ImageCropContext } from './imageCropShared';
export type { CropRequest, ImageCropValue } from './imageCropShared';

/**
 * Cropping a picked image to a fixed shape.
 *
 * On iOS and Android the system picker already does it — `pickImage` asks for
 * `allowsEditing` with an aspect ratio and the OS hands back something the right
 * shape — so this is a pass-through and the whole cropper lives in the `.web`
 * file next to it.
 *
 * That split is the point: `allowsEditing` is silently ignored by
 * expo-image-picker on the web, which is why a portrait photo stayed portrait on
 * blup.sk and stretched the card it landed on.
 */
export function ImageCropProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
