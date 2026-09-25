/**
 * BLUP design tokens.
 *
 * These values come from design_handoff_blup_app/README.md and are meant to be
 * reproduced exactly — colours, type scale, spacing, radius and shadows are
 * final in the handoff, so this file is the single place they live and nothing
 * downstream should hard-code a hex.
 */

export const colors = {
  // --- surfaces -------------------------------------------------------------
  page: '#06080B',            // plane behind the phone
  background: '#0A0D12',      // bg-app
  backgroundElevated: '#0F141B',
  surface: '#12171F',         // bg-card
  surfaceInput: '#0F141B',    // bg-input
  surfaceElevated: '#151A22', // bg-elev-1 — icon buttons, inactive chips
  surfaceElevated2: '#1B2130',// bg-elev-2 — secondary buttons, price badges
  surfacePressed: '#252D3D',  // bg-elev-3 — hover/pressed on secondary
  map: '#0C1017',

  // --- text -----------------------------------------------------------------
  text: '#F2F5F8',
  textSecondary: '#C6CFDB',
  textTertiary: '#9AA6B6',
  textQuaternary: '#7E8A9C',
  textMuted: '#5B6675',
  textDisabled: '#4C5666',
  textInverse: '#06080B',

  // --- accents --------------------------------------------------------------
  accent: '#0080FF',
  accentHover: '#1A8CFF',
  // Accent-coloured TEXT, for a link or a label on a dark surface. It is not a
  // foreground for an accent-coloured background — used that way it paints blue
  // on blue, which is how the crop sheet shipped with two invisible buttons.
  // White is the label colour on `accent`; see buttonLabelPrimary.
  accentText: '#0080FF',
  accentSoft: 'rgba(0, 128, 255, 0.12)',
  accentSofter: 'rgba(0, 128, 255, 0.16)',
  accentBorder: 'rgba(0, 128, 255, 0.4)',

  cyan: '#22D3EE',
  cyanSoft: 'rgba(34, 211, 238, 0.18)',
  pink: '#FF4D8D',
  pinkSoft: 'rgba(255, 77, 141, 0.16)',
  purple: '#A855F7',
  orange: '#FF8A3D',
  green: '#22C55E',

  // --- semantic (mapped onto the palette above) ------------------------------
  success: '#22C55E',
  successSoft: 'rgba(34, 197, 94, 0.16)',
  warning: '#FF8A3D',
  warningSoft: 'rgba(255, 138, 61, 0.16)',
  danger: '#FF4D8D',
  dangerSoft: 'rgba(255, 77, 141, 0.16)',
  info: '#22D3EE',

  /** `teal` is the old name for the handoff's cyan; kept so both read alike. */
  teal: '#22D3EE',
  tealSoft: 'rgba(34, 211, 238, 0.18)',

  // --- lines and overlays ----------------------------------------------------
  border: 'rgba(255, 255, 255, 0.07)',
  borderAccent: 'rgba(0, 128, 255, 0.4)',
  overlay: 'rgba(6, 8, 11, 0.5)',       // glass badge on a photo
  overlayModal: 'rgba(4, 6, 9, 0.66)',  // behind a bottom sheet
  chipOnCover: 'rgba(6, 8, 11, 0.5)',

  // --- map ------------------------------------------------------------------
  mapMarker: '#0080FF',
  mapMarkerPaid: '#A855F7',
  mapUser: '#0080FF',
} as const;

/** Onboarding / hero background: `linear-gradient(180deg, #0A2B54, #0A0D12 62%)`. */
export const heroGradient = ['#0A2B54', '#0A0D12', '#0A0D12'] as const;

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * The five visual families from the handoff. Every event resolves to one of
 * them, which decides its cover gradient and glyph.
 */
export type CategoryFamily = 'music' | 'startup' | 'outdoor' | 'art' | 'spirit';

export const categoryFamilies: Record<
  CategoryFamily,
  { label: string; glyph: string; gradient: readonly [string, string]; color: string }
> = {
  music:   { label: 'Hudba',        glyph: '♪', gradient: ['#FF4D8D', '#A855F7'], color: '#FF4D8D' },
  startup: { label: 'Startupy',     glyph: '◆', gradient: ['#0080FF', '#22D3EE'], color: '#0080FF' },
  outdoor: { label: 'Outdoor',      glyph: '▲', gradient: ['#22C55E', '#22D3EE'], color: '#22C55E' },
  art:     { label: 'Umenie',       glyph: '◼', gradient: ['#FF8A3D', '#FF4D8D'], color: '#FF8A3D' },
  spirit:  { label: 'Spiritualita', glyph: '◎', gradient: ['#A855F7', '#22D3EE'], color: '#A855F7' },
};

/**
 * Database categories are finer-grained than the five visual families, so each
 * one is mapped here. An unknown category falls back to `startup`, which is the
 * neutral blue — never a random colour.
 */
const CATEGORY_TO_FAMILY: Record<string, CategoryFamily> = {
  techno: 'music', house: 'music', hiphop: 'music', rock: 'music', jazz: 'music',
  indie: 'music', festival: 'music', dance: 'music', karaoke: 'music', nightlife: 'music',
  bars: 'music', concert: 'music', party: 'music',

  startups: 'startup', tech: 'startup', design: 'startup', networking: 'startup',
  investing: 'startup', business: 'startup', gaming: 'startup', 'board-games': 'startup',
  language: 'startup', quiz: 'startup', esports: 'startup', conference: 'startup',
  workshop: 'startup', family: 'startup',

  running: 'outdoor', cycling: 'outdoor', climbing: 'outdoor', football: 'outdoor',
  basketball: 'outdoor', swimming: 'outdoor', hiking: 'outdoor', camping: 'outdoor',
  skiing: 'outdoor', surfing: 'outdoor', sport: 'outdoor', volunteering: 'outdoor',
  hockey: 'outdoor', tennis: 'outdoor', fitness: 'outdoor', charity: 'outdoor',

  art: 'art', theatre: 'art', cinema: 'art', museum: 'art', photography: 'art',
  books: 'art', culture: 'art', food: 'art', coffee: 'art', wine: 'art',
  'craft-beer': 'art', cooking: 'art', standup: 'art', comedy: 'art', market: 'art',

  yoga: 'spirit', wellness: 'spirit', meditation: 'spirit', spirit: 'spirit',
  spiritualita: 'spirit',
};

export function familyFor(category: string | null | undefined): CategoryFamily {
  if (!category) return 'startup';
  return CATEGORY_TO_FAMILY[category] ?? (category in categoryFamilies
    ? (category as CategoryFamily)
    : 'startup');
}

/** Cover gradient for an event — from its category, not from its id. */
export function coverGradientFor(
  category: string | null | undefined,
): readonly [string, string] {
  return categoryFamilies[familyFor(category)].gradient;
}

export function glyphFor(category: string | null | undefined): string {
  return categoryFamilies[familyFor(category)].glyph;
}

/** The five filter chips on Domov, in handoff order. */
export const categoryFilters: { key: CategoryFamily; label: string }[] = [
  { key: 'music', label: 'Hudba' },
  { key: 'startup', label: 'Startupy' },
  { key: 'outdoor', label: 'Outdoor' },
  { key: 'art', label: 'Umenie' },
  { key: 'spirit', label: 'Spiritualita' },
];

/** DB categories belonging to a family — used to turn a chip into a query. */
export function categoriesInFamily(family: CategoryFamily): string[] {
  return Object.entries(CATEGORY_TO_FAMILY)
    .filter(([, value]) => value === family)
    .map(([key]) => key);
}

// ---------------------------------------------------------------------------
// Avatars
// ---------------------------------------------------------------------------

/** Cyclic by index, per the handoff. Ink inside an avatar is the page colour. */
export const avatarColors = [
  '#0080FF', '#FF4D8D', '#22D3EE', '#A855F7', '#FF8A3D', '#22C55E',
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

export function avatarColorFor(seed: string | null | undefined): string {
  return avatarColors[hashIndex(seed, avatarColors.length)];
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** Screen gutter is 18; onboarding uses 26. */
export const spacing = {
  xs: 4,
  sm: 6,
  md: 10,
  lg: 14,
  xl: 18,
  xxl: 22,
  xxxl: 32,
  huge: 44,
  /** Horizontal screen margin. */
  gutter: 18,
  gutterWide: 26,
} as const;

export const radius = {
  chip: 13,
  input: 15,
  block: 14,
  md: 16,
  card: 20,
  lg: 22,
  cardLarge: 24,
  xl: 24,
  swipe: 28,
  sheet: 28,
  xxl: 28,
  icon: 26,
  pill: 999,
  sm: 12,
} as const;

export const fontFamily = {
  regular: 'Nunito_400Regular',
  medium: 'Nunito_600SemiBold',
  bold: 'Nunito_700Bold',
  heavy: 'Nunito_800ExtraBold',
  black: 'Nunito_900Black',
  logo: 'Nunito_900Black',
  mono: 'JetBrainsMono_400Regular',
  monoBold: 'JetBrainsMono_600SemiBold',
} as const;

/**
 * The handoff's type scale. Weight 900 is the workhorse for anything that
 * carries a screen; 600 is body. Letter-spacing is negative on the big sizes.
 */
export const typography = {
  logo:        { fontFamily: fontFamily.black,  fontSize: 34, letterSpacing: -1.4 },
  onboardH1:   { fontFamily: fontFamily.black,  fontSize: 32, letterSpacing: -0.5, lineHeight: 37 },
  onboardH2:   { fontFamily: fontFamily.black,  fontSize: 26, letterSpacing: -0.4, lineHeight: 31 },
  display:     { fontFamily: fontFamily.black,  fontSize: 32, letterSpacing: -0.5, lineHeight: 37 },
  screenTitle: { fontFamily: fontFamily.black,  fontSize: 24, letterSpacing: -0.5 },
  title:       { fontFamily: fontFamily.black,  fontSize: 24, letterSpacing: -0.5 },
  eventTitle:  { fontFamily: fontFamily.black,  fontSize: 27, letterSpacing: -0.6, lineHeight: 30 },
  swipeTitle:  { fontFamily: fontFamily.black,  fontSize: 21, letterSpacing: -0.4 },
  profileName: { fontFamily: fontFamily.black,  fontSize: 20 },
  sheetTitle:  { fontFamily: fontFamily.black,  fontSize: 20, letterSpacing: -0.3 },
  section:     { fontFamily: fontFamily.black,  fontSize: 17 },
  heading:     { fontFamily: fontFamily.black,  fontSize: 19 },
  subheading:  { fontFamily: fontFamily.black,  fontSize: 16 },
  cardTitle:   { fontFamily: fontFamily.black,  fontSize: 18, letterSpacing: -0.3 },
  rowTitle:    { fontFamily: fontFamily.heavy,  fontSize: 15 },
  rowTitleSm:  { fontFamily: fontFamily.heavy,  fontSize: 14 },
  body:        { fontFamily: fontFamily.medium, fontSize: 14, lineHeight: 22 },
  bodyStrong:  { fontFamily: fontFamily.heavy,  fontSize: 14, lineHeight: 21 },
  meta:        { fontFamily: fontFamily.bold,   fontSize: 13 },
  metaSm:      { fontFamily: fontFamily.bold,   fontSize: 12 },
  caption:     { fontFamily: fontFamily.medium, fontSize: 13, lineHeight: 19 },
  captionStrong: { fontFamily: fontFamily.bold, fontSize: 13 },
  chip:        { fontFamily: fontFamily.heavy,  fontSize: 13 },
  micro:       { fontFamily: fontFamily.heavy,  fontSize: 11 },
  button:      { fontFamily: fontFamily.heavy,  fontSize: 17 },
  buttonSm:    { fontFamily: fontFamily.heavy,  fontSize: 15 },
  tabLabel:    { fontFamily: fontFamily.heavy,  fontSize: 10 },
  mono:        { fontFamily: fontFamily.monoBold, fontSize: 10, letterSpacing: 1.2 },
  monoStrong:  { fontFamily: fontFamily.monoBold, fontSize: 12, letterSpacing: 1.2 },
  monoSm:      { fontFamily: fontFamily.monoBold, fontSize: 9, letterSpacing: 1.1 },
  monoLg:      { fontFamily: fontFamily.monoBold, fontSize: 11, letterSpacing: 1.4 },
  label:       { fontFamily: fontFamily.monoBold, fontSize: 10, letterSpacing: 1.2 },
} as const;

export const shadow = {
  /** Primary CTA. */
  cta: {
    shadowColor: '#0080FF',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.34,
    shadowRadius: 28,
    elevation: 12,
  },
  ctaLarge: {
    shadowColor: '#0080FF',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.34,
    shadowRadius: 34,
    elevation: 14,
  },
  /** The BLUP circle on the swipe deck. */
  glow: {
    shadowColor: '#0080FF',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.4,
    shadowRadius: 30,
    elevation: 14,
  },
  pin: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.45,
    shadowRadius: 18,
    elevation: 8,
  },
  toast: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.5,
    shadowRadius: 40,
    elevation: 20,
  },
  card: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.35,
    shadowRadius: 20,
    elevation: 8,
  },
  floating: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.5,
    shadowRadius: 28,
    elevation: 16,
  },
} as const;

/** Minimum touch target the handoff requires. */
export const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;
export const MIN_TARGET = 44;

// ---------------------------------------------------------------------------
// Slovak labels for database values
// ---------------------------------------------------------------------------

export const categoryLabel: Record<string, string> = {
  techno: 'Techno', house: 'House', hiphop: 'Hip-hop', rock: 'Rock', jazz: 'Jazz',
  indie: 'Indie', festival: 'Festivaly', running: 'Beh', cycling: 'Cyklo',
  climbing: 'Lezenie', football: 'Futbal', basketball: 'Basket', yoga: 'Joga',
  swimming: 'Plávanie', hiking: 'Turistika', camping: 'Kemping', skiing: 'Lyže',
  surfing: 'Surf', art: 'Umenie', theatre: 'Divadlo', cinema: 'Kino',
  museum: 'Múzeá', photography: 'Fotografia', books: 'Knihy', food: 'Gastro',
  coffee: 'Káva', wine: 'Víno', 'craft-beer': 'Pivo', cooking: 'Varenie',
  startups: 'Startupy', tech: 'Tech', design: 'Dizajn', networking: 'Networking',
  investing: 'Investície', nightlife: 'Nočný život', bars: 'Bary',
  karaoke: 'Karaoke', 'board-games': 'Board games', gaming: 'Gaming',
  language: 'Jazyky', volunteering: 'Dobrovoľníctvo', wellness: 'Wellness',
  meditation: 'Meditácia', dance: 'Tanec', other: 'Iné',
  concert: 'Koncert', party: 'Párty', sport: 'Šport', hockey: 'Hokej',
  tennis: 'Tenis', fitness: 'Fitness', standup: 'Stand-up', comedy: 'Comedy',
  market: 'Trhy', conference: 'Konferencia', workshop: 'Workshop', quiz: 'Kvíz',
  esports: 'Esport', family: 'Pre rodiny', charity: 'Charita',
  music: 'Hudba', startup: 'Startupy', outdoor: 'Outdoor', spirit: 'Spiritualita',
};

export function labelFor(category: string): string {
  return categoryLabel[category] ?? category;
}

/**
 * Interest *groups* (the `category` column on public.interests) — the headings
 * on the onboarding picker.
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

/** Category → emoji, still used by the map markers. */
export const categoryEmoji: Record<string, string> = {
  music: '🎵', startup: '💡', outdoor: '🌿', art: '🎨', spirit: '🧘',
};

export function emojiFor(category: string): string {
  return categoryEmoji[familyFor(category)] ?? '📍';
}
