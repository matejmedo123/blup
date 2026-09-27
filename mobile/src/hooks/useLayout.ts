import { Platform, useWindowDimensions } from 'react-native';

/**
 * One place that decides what shape the app is in.
 *
 * Three sizes, not five: a phone (one column, bottom tabs), a tablet or small
 * laptop (two columns of cards, still bottom tabs), and a desktop browser
 * (sidebar navigation, wide content, master–detail where it helps). Any more
 * than that and every screen ends up with breakpoint logic of its own, which
 * is how a layout stops being predictable.
 *
 * Native is always `phone` regardless of a tablet's width — an iPad build has
 * its own conventions and is not what this is for.
 */
export type LayoutSize = 'phone' | 'tablet' | 'desktop';

/** A browser window narrower than this is treated as a phone. */
export const TABLET_MIN = 720;
export const DESKTOP_MIN = 1080;

/** Widest the reading column ever gets, whatever the monitor. */
export const CONTENT_MAX = 1180;
export const SIDEBAR_WIDTH = 244;

/**
 * Widest a single event card ever gets.
 *
 * On a wide window a one-column list stretched each card across the whole
 * reading column: the cover became a letterbox strip and the title floated
 * alone on a very long line. Cards stop here and centre instead.
 */
export const CARD_MAX = 560;

export interface LayoutInfo {
  size: LayoutSize;
  /** Sidebar navigation instead of a bottom tab bar. */
  isDesktop: boolean;
  /** Enough room for at least two cards side by side. */
  isWide: boolean;
  /** How many event cards fit in a row. */
  columns: 1 | 2 | 3;
  width: number;
}

export function useLayout(): LayoutInfo {
  const { width } = useWindowDimensions();

  if (Platform.OS !== 'web') {
    return { size: 'phone', isDesktop: false, isWide: false, columns: 1, width };
  }

  const size: LayoutSize =
    width >= DESKTOP_MIN ? 'desktop' : width >= TABLET_MIN ? 'tablet' : 'phone';

  return {
    size,
    isDesktop: size === 'desktop',
    isWide: size !== 'phone',
    // Three columns only on a genuinely wide window; two is the honest default
    // for a laptop, where a third column makes each card too narrow to read.
    columns: width >= 1500 ? 3 : size === 'phone' ? 1 : 2,
    width,
  };
}

/**
 * Stĺpec obsahu na monitore.
 *
 * Obrazovky, ktoré si kreslia vlastný koreň (tab-y, zoznamy ľudí a komunít,
 * nástenka organizátora), sa bez tohto roztiahli cez celú plochu vedľa
 * bočného menu — na 1920 px to znamenalo riadok so 60 znakmi a tlačidlo
 * „Sledujem" 1600 px od mena, ku ktorému patrí. `Screen` to má v sebe; toto
 * je to isté pre tých, čo `Screen` nepoužívajú.
 *
 * Vracia `null` na telefóne, aby sa tam nepridával žiadny štýl navyše.
 */
export function usePageColumn() {
  const layout = useLayout();
  if (!layout.isWide) return null;
  return { width: '100%' as const, maxWidth: CONTENT_MAX, alignSelf: 'center' as const };
}
