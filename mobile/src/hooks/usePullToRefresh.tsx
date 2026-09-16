import type { ScrollViewProps } from 'react-native';

export interface PullToRefresh {
  /** Spread onto the scroller. Empty on native — RefreshControl already works. */
  handlers: Partial<ScrollViewProps>;
  /** Rendered above the content. Null on native. */
  indicator: React.ReactNode;
}

/**
 * Pull down to reload, on the web.
 *
 * Native already has this: `RefreshControl` is a real thing on iOS and Android.
 * On react-native-web it renders nothing and listens to nothing, so every screen
 * that passed one had a refresh gesture on a phone and none in a browser —
 * including on a phone browser, which is where people expect it most.
 *
 * The web implementation lives in the `.web` file next to this one.
 *
 * NOTE ON THE EXTENSION. This file is `.tsx` even though it contains no JSX,
 * and it has to be. Metro resolves a platform pair extension-major: every
 * candidate for `.ts` is tried before any candidate for `.tsx`, so a
 * `usePullToRefresh.ts` shadows `usePullToRefresh.web.tsx` completely — the web
 * build silently got this stub, the hook did nothing, and nothing anywhere said
 * so. Same trap as `tags.ts` shadowing `tags.web.tsx`. `scripts/check-platform-files.mjs`
 * fails the build if the pair is ever split across extensions again.
 */
export function usePullToRefresh(
  _onRefresh?: () => void | Promise<unknown>,
  _refreshing?: boolean,
): PullToRefresh {
  return { handlers: {}, indicator: null };
}
