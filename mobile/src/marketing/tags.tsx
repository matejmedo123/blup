/**
 * Ad platform tags — the native no-op.
 *
 * Note the extension: this file is `.tsx`, not `.ts`, and it has to be. Metro
 * walks `sourceExts` in order and takes the first hit, so a `tags.ts` here
 * resolves *before* `tags.web.tsx` is ever considered — on the web too. That is
 * exactly what happened: the whole web module was shadowed by this one, so no
 * pixel ever loaded and the cookie bar never appeared, on the only platform
 * that has cookies. A platform pair must share an extension.
 *
 * There is no Meta pixel or Google tag inside a React Native app; conversion
 * measurement on a phone belongs to the store SDKs, which BLUP does not ship.
 * The functions exist so screens can call `track()` without checking platform.
 */

export interface TrackedItem {
  id: string;
  name?: string;
  quantity?: number;
}

export interface TrackPayload {
  valueCents?: number;
  currency?: string;
  items?: TrackedItem[];
  contentName?: string;
}

export type TrackEvent =
  | 'view_event'
  | 'add_to_cart'
  | 'begin_checkout'
  | 'purchase'
  | 'sign_up';

export function track(_event: TrackEvent, _payload: TrackPayload = {}): void {
  // no-op on native
}

export function MarketingTags(): null {
  return null;
}

export function hasConsent(): boolean { return false; }
export function setConsent(_accepted: boolean): void { /* web only */ }
export function consentAnswered(): boolean { return true; }
export function openCookieSettings(): void { /* web only — no browser storage here */ }
export function onCookieSettingsOpen(_listener: () => void): () => void {
  return () => {};
}
