import React, { createContext, useContext, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { getMyLook } from '@/api/premium';
import { colors } from '@/theme';

/**
 * The colour of BLUP, per person.
 *
 * Premium can repaint the accent — the one colour that carries the brand
 * through the app: the primary button, the selected chip, the active tab, the
 * switch that is on. Everything else stays where it is, because a theme that
 * repaints the whole surface is a different app with the same data in it.
 *
 * Why a context and not a rebuilt `colors`: every screen calls
 * `StyleSheet.create` at module scope, which captures the values once, at
 * import. Swapping the palette afterwards changes nothing already created —
 * so the handful of places where the colour is actually *seen* read it from
 * here instead, and it changes the moment somebody picks a new one, with no
 * restart and no reload.
 */
export type AccentKey = 'blue' | 'pink' | 'violet' | 'teal' | 'amber' | 'lime';

export interface AccentPalette {
  key: AccentKey;
  /** The fill. White text is always legible on it — that is how they were chosen. */
  accent: string;
  /** The same hue as *text* on a dark surface, lightened where it had to be. */
  text: string;
  soft: string;
  border: string;
  label: string;
}

/**
 * Six, not a colour picker.
 *
 * Each one is dark enough for white label text on a filled button and light
 * enough to read as text on the near-black ground. The `text` value is
 * deliberately not always the same as `accent`: amber and lime are legible as
 * fills but muddy as text, so they are lifted.
 */
export const ACCENTS: Record<AccentKey, AccentPalette> = {
  blue: {
    key: 'blue', label: 'Modrá', accent: '#0080FF', text: '#0080FF',
    soft: 'rgba(0, 128, 255, 0.12)', border: 'rgba(0, 128, 255, 0.4)',
  },
  pink: {
    key: 'pink', label: 'Ružová', accent: '#FF4D8D', text: '#FF6FA3',
    soft: 'rgba(255, 77, 141, 0.14)', border: 'rgba(255, 77, 141, 0.4)',
  },
  violet: {
    key: 'violet', label: 'Fialová', accent: '#8B5CF6', text: '#A78BFA',
    soft: 'rgba(139, 92, 246, 0.14)', border: 'rgba(139, 92, 246, 0.4)',
  },
  teal: {
    key: 'teal', label: 'Tyrkysová', accent: '#14B8A6', text: '#2DD4BF',
    soft: 'rgba(20, 184, 166, 0.14)', border: 'rgba(20, 184, 166, 0.4)',
  },
  amber: {
    key: 'amber', label: 'Jantárová', accent: '#F59E0B', text: '#FBBF24',
    soft: 'rgba(245, 158, 11, 0.14)', border: 'rgba(245, 158, 11, 0.4)',
  },
  lime: {
    key: 'lime', label: 'Limetková', accent: '#84CC16', text: '#A3E635',
    soft: 'rgba(132, 204, 22, 0.14)', border: 'rgba(132, 204, 22, 0.4)',
  },
};

export const DEFAULT_ACCENT = ACCENTS.blue;

interface AccentValue extends AccentPalette {
  /** The wallpaper behind the chat, when there is one. */
  chatWallpaper: string | null;
  isPremium: boolean;
}

const AccentContext = createContext<AccentValue>({
  ...DEFAULT_ACCENT,
  chatWallpaper: null,
  isPremium: false,
});

export function useAccent(): AccentValue {
  return useContext(AccentContext);
}

export function AccentProvider({ children }: { children: React.ReactNode }) {
  // The server decides what applies: a lapsed subscription keeps the saved
  // colour and stops painting it, and that rule lives in my_look(), not here.
  const look = useQuery({
    queryKey: ['premium', 'look'],
    queryFn: getMyLook,
    staleTime: 5 * 60 * 1000,
    // A signed-out visitor sees BLUP blue; asking would only produce a 401.
    retry: false,
  });

  const value = useMemo<AccentValue>(() => {
    const key = look.data?.accent_color as AccentKey | null | undefined;
    const palette = (key && ACCENTS[key]) || DEFAULT_ACCENT;
    return {
      ...palette,
      chatWallpaper: look.data?.chat_wallpaper ?? null,
      isPremium: look.data?.is_premium ?? false,
    };
  }, [look.data]);

  return <AccentContext.Provider value={value}>{children}</AccentContext.Provider>;
}

/** The default palette, for styles created at module scope. */
export const staticAccent = {
  accent: colors.accent,
  text: colors.accentText,
  soft: colors.accentSoft,
  border: colors.accentBorder,
};
