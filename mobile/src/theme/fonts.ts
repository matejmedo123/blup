/**
 * Fonts, the shared entry point.
 *
 * The native build downloads the .ttf faces through expo-font and holds the
 * splash screen until they are ready — see fonts.native.ts. The web does not
 * come here at all: fonts.web.ts returns immediately, because on the web the
 * faces are declared as @font-face in app/+html.tsx and the browser streams
 * them with `font-display: swap`.
 *
 * This file is the fallback for any platform without its own variant, and it
 * must never be the one that runs on the web — which is why it is a `.ts` next
 * to a `.web.ts` rather than next to a `.web.tsx`. Metro tries every candidate
 * for one extension before any candidate for the next, so a `.ts` beside a
 * `.web.tsx` silently wins on the web too.
 */
export { useAppFonts } from './fonts.native';
