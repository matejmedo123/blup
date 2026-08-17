/**
 * BLUP design tokens.
 *
 * Dark-first (Spotify × Google Maps × BeReal), high contrast, one accent.
 * Every screen pulls from here — no ad-hoc hex values in components.
 */
export const colors = {
  // surfaces
  background: '#07070A',
  surface: '#121218',
  surfaceElevated: '#1A1A22',
  surfacePressed: '#22222C',
  overlay: 'rgba(7, 7, 10, 0.82)',

  // text
  text: '#F5F5F7',
  textSecondary: '#A0A0AE',
  textTertiary: '#6C6C7C',
  textInverse: '#07070A',

  // brand
  accent: '#5B8CFF',
  accentPressed: '#4A76DB',
  accentSoft: 'rgba(91, 140, 255, 0.14)',
  blup: '#7C5CFF',

  // semantic
  success: '#3ECF8E',
  successSoft: 'rgba(62, 207, 142, 0.14)',
  warning: '#FFB020',
  warningSoft: 'rgba(255, 176, 32, 0.14)',
  danger: '#FF5A5F',
  dangerSoft: 'rgba(255, 90, 95, 0.14)',

  // lines
  border: '#26262F',
  borderStrong: '#35353F',

  // map
  mapMarker: '#5B8CFF',
  mapMarkerPaid: '#7C5CFF',
  mapUser: '#3ECF8E',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 18,
  xl: 26,
  pill: 999,
} as const;

export const typography = {
  display: { fontSize: 34, fontWeight: '800' as const, letterSpacing: -0.8 },
  title: { fontSize: 26, fontWeight: '700' as const, letterSpacing: -0.5 },
  heading: { fontSize: 20, fontWeight: '700' as const, letterSpacing: -0.3 },
  subheading: { fontSize: 17, fontWeight: '600' as const },
  body: { fontSize: 15, fontWeight: '400' as const },
  bodyStrong: { fontSize: 15, fontWeight: '600' as const },
  caption: { fontSize: 13, fontWeight: '500' as const },
  micro: { fontSize: 11, fontWeight: '600' as const, letterSpacing: 0.4 },
} as const;

export const shadow = {
  card: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 8,
  },
  floating: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.45,
    shadowRadius: 24,
    elevation: 14,
  },
} as const;

/** Category → emoji, used on cards and map markers. */
export const categoryEmoji: Record<string, string> = {
  techno: '🔊', house: '🏠', hiphop: '🎤', rock: '🎸', jazz: '🎷', indie: '🎧',
  festival: '🎪', running: '🏃', cycling: '🚴', climbing: '🧗', football: '⚽',
  basketball: '🏀', yoga: '🧘', swimming: '🏊', hiking: '🥾', camping: '⛺',
  skiing: '🎿', surfing: '🏄', art: '🎨', theatre: '🎭', cinema: '🎬',
  museum: '🏛️', photography: '📷', books: '📚', food: '🍜', coffee: '☕',
  wine: '🍷', 'craft-beer': '🍺', cooking: '👨‍🍳', startups: '🚀', tech: '💻',
  design: '✏️', networking: '🤝', investing: '📈', nightlife: '🌃', bars: '🍸',
  karaoke: '🎙️', 'board-games': '🎲', gaming: '🎮', language: '🗣️',
  volunteering: '💚', wellness: '🌿', meditation: '🕯️', dance: '💃', other: '✨',
};

export function emojiFor(category: string): string {
  return categoryEmoji[category] ?? '✨';
}
