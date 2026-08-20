import React from 'react';
import { useSegments } from 'expo-router';

import { DesktopShell } from '@/components/DesktopShell';
import { useLayout } from '@/hooks/useLayout';

/**
 * Decides whether a screen gets the desktop chrome.
 *
 * The sidebar used to live inside the tabs layout, which meant it appeared on
 * exactly five screens: the moment you opened an event, a ticket, the basket or
 * the organizer desk, the navigation vanished and the content stretched across
 * the monitor. On a phone that is correct — a detail screen takes the whole
 * screen and you come back with the arrow. On a desktop it reads as falling out
 * of the app.
 *
 * So the frame moved up here, and now wraps everything except the three places
 * where an app frame would be wrong:
 *
 *   (auth)        signing in is not "inside" the app yet
 *   (onboarding)  a linear flow with its own progress chrome
 *   index         the launch screen, which only decides where to send you
 *
 * `useSegments()` rather than `usePathname()` on purpose: segments keep the
 * group names — `['(auth)', 'sign-in']` — and groups are invisible in the URL.
 * `/profile` alone cannot tell you whether it is the onboarding form or the
 * account tab.
 */
const BARE_GROUPS = new Set(['(auth)', '(onboarding)']);

export function AppFrame({ children }: { children: React.ReactNode }) {
  const layout = useLayout();
  const segments = useSegments();

  if (!layout.isDesktop) return <>{children}</>;

  const first = String(segments[0] ?? '');

  // `auth/callback` and `auth/reset-password` are the links people arrive on
  // from an email; they are part of signing in, not part of the app.
  const bare = BARE_GROUPS.has(first) || first === 'auth' || first === '';

  if (bare) return <>{children}</>;

  return <DesktopShell>{children}</DesktopShell>;
}
