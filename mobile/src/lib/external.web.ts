/**
 * Web variant: a full navigation, never a new window.
 *
 * These URLs are always fetched from the server first, so by the time we have
 * one the click that asked for it is long over — and a browser only lets a
 * pop-up through while a user gesture is still live. `window.open` here is
 * blocked silently, which to the user is a button that does nothing at all.
 * Navigating the current tab has no such rule, and the provider returns to us
 * through its configured return URL anyway.
 */
export async function openExternal(url: string): Promise<void> {
  window.location.assign(url);
}
