/**
 * BLUP design tokens.
 *
 * Dark, blue-tinted, one vivid blue for action and a teal for the social layer.
 * Covers are generated gradients with a diagonal stripe texture rather than
 * stock photography, so an event without a picture still looks intentional.
 *
 * Nothing in a component should hardcode a colour, radius or font — it all
 * comes from here.
 */

export const colors = {
  // surfaces — near-black with a cool cast
  background: '#08090D',
  backgroundElevated: '#0C0E14',
  surface: '#12161F',
  surfaceElevated: '#181D28',
  surfacePressed: '#202634',
  overlay: 'rgba(8, 9, 13, 0.78)',
  scrim: 'rgba(8, 9, 13, 0.55)',

  // text
  text: '#FFFFFF',
  textSecondary: '#9BA3B4',
  textTertiary: '#5F6675',
  textInverse: '#08090D',

  // brand
  accent: '#2B6BFF',
  accentPressed: '#1E56D6',
  accentSoft: 'rgba(43, 107, 255, 0.16)',
  accentText: '#5A94FF',
  accentGlow: 'rgba(43, 107, 255, 0.45)',

  // secondary accent — social / connect
  teal: '#4FD1C5',
  tealSoft: 'rgba(79, 209, 197, 0.14)',

  // semantic
  success: '#22C55E',
  successSoft: 'rgba(34, 197, 94, 0.14)',
  warning: '#FBBF24',
  warningSoft: 'rgba(251, 191, 36, 0.14)',
  danger: '#FF4D6D',
  dangerSoft: 'rgba(255, 77, 109, 0.14)',

  // lines
  border: 'rgba(255, 255, 255, 0.07)',
  borderStrong: 'rgba(255, 255, 255, 0.14)',

  // chips sitting on top of a cover image
  chipOnCover: 'rgba(10, 10, 14, 0.55)',

  // map
  mapMarker: '#2B6BFF',
  mapMarkerPaid: '#A855F7',
  mapUser: '#4FD1C5',
} as const;

/** Onboarding / hero background: navy fading into black. */
export const heroGradient = ['#16294A', '#0B1220', '#08090D'] as const;

/**
 * Cover gradients. An event with no photo gets one deterministically from its
 * id, so the same event always looks the same everywhere in the app.
 */
export const coverGradients: readonly (readonly [string, string])[] = [
  ['#F05CA8', '#A855F7'], // pink → purple
  ['#2E7BF6', '#56C7F0'], // blue → cyan
  ['#F97316', '#F0447A'], // orange → pink
  ['#22C55E', '#4FD1C5'], // green → teal
  ['#7C5CFF', '#2B6BFF'], // violet → blue
  ['#FBBF24', '#F97316'], // amber → orange
  ['#06B6D4', '#3B82F6'], // cyan → blue
  ['#EC4899', '#F43F5E'], // magenta → rose
] as const;

/** Avatar backgrounds, also picked deterministically from the name/id. */
export const avatarColors = [
  '#2B6BFF', '#FF4D8D', '#22D3EE', '#A855F7', '#FB923C', '#22C55E', '#FBBF24', '#F43F5E',
] as const;

/** Stable index from any string — same input, same colour, every render. */
export function hashIndex(seed: string | null | undefined, length: number): number {
  if (!seed) return 0;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % length;
}

export function coverGradientFor(seed: string | null | undefined): readonly [string, string] {
  return coverGradients[hashIndex(seed, coverGradients.length)];
}

export function avatarColorFor(seed: string | null | undefined): string {
  return avatarColors[hashIndex(seed, avatarColors.length)];
}

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
  sm: 10,
  md: 14,
  lg: 20,
  xl: 26,
  xxl: 32,
  pill: 999,
} as const;

/**
 * Nunito for everything readable, JetBrains Mono for the small technical
 * labels ("◎ Bratislava", "[ foto z eventu ]", "0 blupov").
 */
export const fontFamily = {
  regular: 'Nunito_400Regular',
  medium: 'Nunito_600SemiBold',
  bold: 'Nunito_700Bold',
  black: 'Nunito_800ExtraBold',
  mono: 'JetBrainsMono_400Regular',
  monoBold: 'JetBrainsMono_700Bold',
} as const;

export const typography = {
  logo: { fontFamily: fontFamily.black, fontSize: 34, letterSpacing: -1 },
  display: { fontFamily: fontFamily.black, fontSize: 34, letterSpacing: -0.8, lineHeight: 40 },
  title: { fontFamily: fontFamily.black, fontSize: 28, letterSpacing: -0.6, lineHeight: 34 },
  heading: { fontFamily: fontFamily.bold, fontSize: 21, letterSpacing: -0.3, lineHeight: 27 },
  subheading: { fontFamily: fontFamily.bold, fontSize: 17, letterSpacing: -0.2 },
  body: { fontFamily: fontFamily.regular, fontSize: 15, lineHeight: 22 },
  bodyStrong: { fontFamily: fontFamily.medium, fontSize: 15, lineHeight: 22 },
  caption: { fontFamily: fontFamily.regular, fontSize: 13, lineHeight: 18 },
  captionStrong: { fontFamily: fontFamily.medium, fontSize: 13, lineHeight: 18 },
  button: { fontFamily: fontFamily.bold, fontSize: 16, letterSpacing: -0.2 },
  chip: { fontFamily: fontFamily.medium, fontSize: 13 },
  mono: { fontFamily: fontFamily.mono, fontSize: 12, letterSpacing: 0.4 },
  monoStrong: { fontFamily: fontFamily.monoBold, fontSize: 12, letterSpacing: 0.4 },
  label: { fontFamily: fontFamily.medium, fontSize: 10, letterSpacing: 1.2 },
} as const;

export const shadow = {
  card: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
    elevation: 10,
  },
  floating: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.5,
    shadowRadius: 28,
    elevation: 16,
  },
  glow: {
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.6,
    shadowRadius: 20,
    elevation: 12,
  },
} as const;

/** Category → emoji, used on markers and as the cover glyph. */
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

/** Slovak category labels for chips and filters. */
export const categoryLabel: Record<string, string> = {
  techno: 'Techno', house: 'House', hiphop: 'Hip-hop', rock: 'Rock', jazz: 'Jazz',
  indie: 'Indie', festival: 'Festivaly', running: 'Beh', cycling: 'Cyklo',
  climbing: 'Lezenie', football: 'Futbal', basketball: 'Basket', yoga: 'Joga',
  swimming: 'Plávanie', hiking: 'Turistika', camping: 'Kemping', skiing: 'Lyže',
  surfing: 'Surf', art: 'Umenie', theatre: 'Divadlo', cinema: 'Kino',
  museum: 'Múzeá', photography: 'Fotenie', books: 'Knihy', food: 'Jedlo',
  coffee: 'Káva', wine: 'Víno', 'craft-beer': 'Pivo', cooking: 'Varenie',
  startups: 'Startupy', tech: 'Tech', design: 'Dizajn', networking: 'Networking',
  investing: 'Investície', nightlife: 'Nočný život', bars: 'Bary',
  karaoke: 'Karaoke', 'board-games': 'Doskovky', gaming: 'Gaming',
  language: 'Jazyky', volunteering: 'Dobrovoľníctvo', wellness: 'Wellness',
  meditation: 'Meditácia', dance: 'Tanec', other: 'Iné',
};

export function labelFor(category: string): string {
  return categoryLabel[category] ?? category;
}

/**
 * Interest *groups* (the `category` column on public.interests) — the headings
 * on the onboarding picker. Distinct from `categoryLabel`, which labels an
 * event's category.
 */
export const interestGroupLabel: Record<string, string> = {
  music: 'Hudba',
  sport: 'Šport',
  outdoor: 'Vonku',
  culture: 'Kultúra',
  food: 'Jedlo a pitie',
  business: 'Biznis',
  nightlife: 'Nočný život',
  social: 'Spoločenské',
  wellness: 'Wellness',
  other: 'Iné',
};

export function interestGroupFor(category: string): string {
  return interestGroupLabel[category] ?? category;
}
