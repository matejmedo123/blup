/**
 * On the web there is nothing to wait for.
 *
 * The seven faces are declared as @font-face in app/+html.tsx, subset to
 * latin + latin-ext and served as woff2 (149 kB for the set, against 870 kB of
 * .ttf that expo-font would fetch). The browser applies them when they arrive
 * and shows a system face until then, so holding the app back would only mean
 * a blank screen for the same download.
 *
 * Returning true unconditionally is the whole file: the root layout's
 * `if (!fontsReady) return null` was costing several seconds of nothing on a
 * phone connection.
 */
export function useAppFonts(): boolean {
  return true;
}
