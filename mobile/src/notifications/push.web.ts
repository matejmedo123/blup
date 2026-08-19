import { supabase } from '@/lib/supabase';
import { env } from '@/lib/env';

/**
 * Web Push.
 *
 * The browser hands out a subscription — an endpoint plus two keys — and the
 * server encrypts each notification so that only this browser can read it
 * (RFC 8291). The whole subscription is stored as the token, because the server
 * needs every part of it to deliver.
 *
 * Requires HTTPS, a service worker, and on iOS the site to be installed to the
 * home screen; Apple simply does not grant push to a Safari tab. Each of those
 * is reported as its own reason rather than a blanket failure, because they
 * have different fixes.
 */

export type PushRegistrationResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'UNSUPPORTED' | 'DENIED' | 'NOT_CONFIGURED' | 'NEEDS_INSTALL'; message: string };

const MESSAGES = {
  UNSUPPORTED: 'Tento prehliadač nepodporuje notifikácie.',
  DENIED: 'Notifikácie si zamietol. Povoliť sa dajú v nastaveniach stránky.',
  NOT_CONFIGURED: 'Notifikácie zatiaľ nie sú na tomto nasadení nastavené.',
  NEEDS_INSTALL:
    'Na iPhone fungujú notifikácie až keď si Blup pridáš na plochu: Zdieľať → Pridať na plochu.',
} as const;

/** The VAPID key travels as base64url text and has to reach the browser as
 *  bytes backed by a plain ArrayBuffer, which is what `applicationServerKey`
 *  accepts. */
const urlBase64ToBytes = (value: string): ArrayBuffer => {
  const padded = (value + '='.repeat((4 - (value.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
};

/** iOS grants push only to an installed PWA, never to a plain Safari tab. */
function needsInstall(): boolean {
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (window.navigator as { standalone?: boolean }).standalone === true;
  return isIos && !standalone;
}

export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

export async function registerForPushNotifications(): Promise<PushRegistrationResult> {
  if (typeof window === 'undefined' || !('Notification' in window) || !('PushManager' in window)) {
    return { ok: false, reason: 'UNSUPPORTED', message: MESSAGES.UNSUPPORTED };
  }
  if (!env.vapidPublicKey) {
    return { ok: false, reason: 'NOT_CONFIGURED', message: MESSAGES.NOT_CONFIGURED };
  }
  if (needsInstall()) {
    return { ok: false, reason: 'NEEDS_INSTALL', message: MESSAGES.NEEDS_INSTALL };
  }

  const registration = await ensureServiceWorker();
  if (!registration) {
    return { ok: false, reason: 'UNSUPPORTED', message: MESSAGES.UNSUPPORTED };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { ok: false, reason: 'DENIED', message: MESSAGES.DENIED };
  }

  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    // Chrome refuses a subscription that could deliver silently, and it is the
    // right rule: a push the person never sees is a tracking beacon.
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToBytes(env.vapidPublicKey),
  });

  const token = JSON.stringify(subscription.toJSON());

  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return { ok: false, reason: 'UNSUPPORTED', message: 'Najprv sa prihlás.' };

  const { error } = await supabase.from('push_tokens').upsert(
    {
      user_id: userId,
      token,
      platform: 'web',
      device_name: navigator.userAgent.slice(0, 120),
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'token' },
  );
  if (error) throw error;

  return { ok: true, token };
}

export async function unregisterPushToken(token: string): Promise<void> {
  await supabase.from('push_tokens').delete().eq('token', token);

  const registration = await navigator.serviceWorker?.getRegistration('/');
  const subscription = await registration?.pushManager.getSubscription();
  await subscription?.unsubscribe();
}

export async function scheduleEventReminder(_event: {
  id: string;
  title: string;
  start_at: string;
}): Promise<string | null> {
  // A local reminder would die with the tab. The reminder that actually fires
  // is the server-side one, which reaches this browser through Web Push.
  return null;
}

export async function cancelReminder(_notificationId: string): Promise<void> {}

export async function setBadgeCount(count: number): Promise<void> {
  const badging = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count > 0) await badging.setAppBadge?.(count);
    else await badging.clearAppBadge?.();
  } catch {
    // Badging is not supported everywhere; it is a nicety, not a feature.
  }
}
