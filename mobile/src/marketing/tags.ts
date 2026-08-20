/**
 * Ad platform tags — the native no-op.
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
