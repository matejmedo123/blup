/**
 * Registers the service worker as soon as the app mounts.
 *
 * Done here rather than lazily inside the notification flow, because the worker
 * has a second job that has nothing to do with push: keeping the app shell
 * available when the network is not. Waiting until somebody enables
 * notifications would mean the people who never do are the ones with no
 * offline support.
 */
export async function registerServiceWorker(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  // A service worker on http:// only works on localhost, and registering it
  // elsewhere throws — which would surface as a console error on every load.
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;

  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch (error) {
    // Not fatal: the app works without it, just without offline and push.
    console.warn('Service worker registration failed:', error);
  }
}
