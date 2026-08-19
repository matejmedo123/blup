/**
 * Push notifications in a browser.
 *
 * Web Push needs a service worker, a VAPID key pair and a permission prompt
 * that Safari only honours for installed PWAs — a different integration, not a
 * thin shim over the native one. Rather than fake it, the web build reports
 * plainly that device notifications are off and leans on the in-app activity
 * feed and email, which both work here today.
 *
 * The notification *rows* still exist: everything in the app's Activity screen
 * comes from the database, so nothing is lost — only the OS-level banner.
 */

export type PushRegistrationResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'UNSUPPORTED' | 'DENIED' | 'NOT_CONFIGURED'; message: string };

const UNSUPPORTED =
  'Vo webovej verzii zatiaľ neposielame notifikácie do zariadenia. ' +
  'Všetko nájdeš v Aktivite a vstupenky ti chodia e-mailom.';

export async function registerForPushNotifications(): Promise<PushRegistrationResult> {
  return { ok: false, reason: 'UNSUPPORTED', message: UNSUPPORTED };
}

export async function unregisterPushToken(_token: string): Promise<void> {
  // Nothing to unregister: the web build never registers a token.
}

export async function scheduleEventReminder(_event: {
  id: string;
  title: string;
  start_at: string;
}): Promise<string | null> {
  // A local reminder would die with the tab. The event reminder that actually
  // fires is the server-side one, which reaches the phone app and the inbox.
  return null;
}

export async function cancelReminder(_notificationId: string): Promise<void> {}

export async function setBadgeCount(_count: number): Promise<void> {}
