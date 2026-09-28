import React from 'react';

import type { StoryOverlay } from '@/api/stories';
import { StoryOverlayText } from '@/components/StoryOverlayText';

/**
 * Text cez príbeh, ako ho vidí divák.
 *
 * Celé kreslenie je v `StoryOverlayText` — tu zostáva len prevod z toho, čo
 * prišlo zo servera. Predtým mal prehrávač vlastnú kópiu kreslenia a od
 * editora sa líšila: editor ukazoval text vyššie, než kde nakoniec pristál.
 */
export function StoryText({
  overlay, frame,
}: {
  overlay: StoryOverlay;
  /** Rámček 9:16, v ktorom sa príbeh práve hrá. Prehrávač si ho meria. */
  frame: { width: number; height: number };
}) {
  return (
    <StoryOverlayText
      text={overlay.text ?? ''}
      spot={{ x: overlay.x ?? 0.5, y: overlay.y ?? 0.5 }}
      color={overlay.color}
      size={overlay.size}
      frame={frame}
    />
  );
}
