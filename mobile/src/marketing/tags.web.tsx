import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { supabase } from '@/lib/supabase';
import { isConfigured } from '@/lib/env';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Meta and Google tags on the web.
 *
 * Three rules this file exists to keep.
 *
 * 1. THE ADMIN SUPPLIES AN ID, NOT A SCRIPT. The loaders below are written
 *    here, in code that ships with the app; the only thing that comes from the
 *    database is an identifier whose shape a CHECK constraint has already
 *    validated. Pasted markup would run on the origin that holds every
 *    visitor's session — this is the whole reason the admin screen has no
 *    "custom code" box.
 *
 * 2. NOTHING LOADS BEFORE CONSENT. When `consent_required` is on (the default),
 *    no third-party script is injected until the visitor has said yes, and the
 *    answer is remembered in localStorage. Events fired before that are dropped,
 *    not queued — a queue that flushes on consent is consent-washing.
 *
 * 3. NO PERSONAL DATA IS SENT. The events carry an event id, a quantity and a
 *    value. Not an email, not a name, not a user id.
 */

const CONSENT_KEY = 'blup.marketing.consent';

interface Tags {
  meta_pixel_id: string | null;
  google_ads_id: string | null;
  google_ads_purchase_label: string | null;
  google_analytics_id: string | null;
  consent_required: boolean;
}

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

declare global {
  interface Window {
    fbq?: ((...args: unknown[]) => void) & { callMethod?: unknown; queue?: unknown[] };
    _fbq?: unknown;
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

let loaded: Tags | null = null;
let injected = false;

/**
 * Reopening the consent bar from the footer.
 *
 * Consent that cannot be withdrawn as easily as it was given is not consent, so
 * "Aktualizovať nastavenia cookies" has to bring the same bar back — including
 * for somebody who already said no, and including when no tag is configured, in
 * which case the bar says exactly that.
 */
const reopenListeners = new Set<() => void>();

export function openCookieSettings(): void {
  for (const listener of reopenListeners) listener();
}

export function onCookieSettingsOpen(listener: () => void): () => void {
  reopenListeners.add(listener);
  return () => { reopenListeners.delete(listener); };
}

export function hasConsent(): boolean {
  try {
    return globalThis.localStorage?.getItem(CONSENT_KEY) === 'yes';
  } catch {
    return false;
  }
}

export function setConsent(accepted: boolean): void {
  try {
    globalThis.localStorage?.setItem(CONSENT_KEY, accepted ? 'yes' : 'no');
  } catch {
    /* private mode: the answer simply does not persist */
  }
  if (accepted && loaded) inject(loaded);
}

/** True once the visitor has answered either way. */
export function consentAnswered(): boolean {
  try {
    return globalThis.localStorage?.getItem(CONSENT_KEY) !== null;
  } catch {
    return true;
  }
}

function injectMeta(pixelId: string): void {
  /* eslint-disable */
  const fbq: any = function (...args: unknown[]) {
    (fbq.callMethod ? fbq.callMethod.apply(fbq, args) : fbq.queue.push(args));
  };
  fbq.queue = [];
  fbq.loaded = true;
  fbq.version = '2.0';
  window.fbq = window.fbq || fbq;
  window._fbq = window._fbq || window.fbq;
  /* eslint-enable */

  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://connect.facebook.net/en_US/fbevents.js';
  document.head.appendChild(script);

  window.fbq?.('init', pixelId);
  window.fbq?.('track', 'PageView');
}

function injectGoogle(ids: string[]): void {
  const layer: unknown[] = window.dataLayer || [];
  window.dataLayer = layer;

  // gtag must push the real `arguments` object — Google's tag reads it as an
  // array-like, and an arrow function has no `arguments` to give it.
  // eslint-disable-next-line prefer-rest-params, func-style
  const gtag = function gtag() { layer.push(arguments); } as (...args: unknown[]) => void;
  window.gtag = gtag;

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ids[0])}`;
  document.head.appendChild(script);

  gtag('js', new Date());
  for (const id of ids) gtag('config', id, { anonymize_ip: true });
}

function inject(tags: Tags): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;

  if (tags.meta_pixel_id) injectMeta(tags.meta_pixel_id);

  const googleIds = [tags.google_analytics_id, tags.google_ads_id].filter(Boolean) as string[];
  if (googleIds.length) injectGoogle(googleIds);
}

/**
 * One event, sent to whichever platforms are on. The names differ per platform,
 * so the mapping lives here rather than at every call site.
 */
export function track(event: TrackEvent, payload: TrackPayload = {}): void {
  if (!loaded || !injected) return;

  const value = (payload.valueCents ?? 0) / 100;
  const currency = payload.currency ?? 'EUR';
  const ids = (payload.items ?? []).map((item) => item.id);

  const META: Record<TrackEvent, string | null> = {
    view_event: 'ViewContent',
    add_to_cart: 'AddToCart',
    begin_checkout: 'InitiateCheckout',
    purchase: 'Purchase',
    sign_up: 'CompleteRegistration',
  };

  const metaName = META[event];
  if (metaName) {
    window.fbq?.('track', metaName, {
      content_type: 'product',
      content_ids: ids,
      content_name: payload.contentName,
      value,
      currency,
    });
  }

  const GOOGLE: Record<TrackEvent, string> = {
    view_event: 'view_item',
    add_to_cart: 'add_to_cart',
    begin_checkout: 'begin_checkout',
    purchase: 'purchase',
    sign_up: 'sign_up',
  };

  window.gtag?.('event', GOOGLE[event], {
    currency,
    value,
    items: (payload.items ?? []).map((item) => ({
      item_id: item.id,
      item_name: item.name,
      quantity: item.quantity ?? 1,
    })),
  });

  // A purchase is also the Google Ads conversion, which needs the label.
  if (event === 'purchase' && loaded.google_ads_id && loaded.google_ads_purchase_label) {
    window.gtag?.('event', 'conversion', {
      send_to: `${loaded.google_ads_id}/${loaded.google_ads_purchase_label}`,
      value,
      currency,
    });
  }
}

/**
 * Mounted once, at the root. Fetches what the admin configured, loads the
 * platforms if it may, and asks first if it must.
 *
 * The bar has two real buttons. "Odmietnuť" is not a smaller, greyer, harder-to
 * -find link than "Súhlasím": a refusal that takes more effort than an
 * acceptance is not a choice, and in the EU it is not consent either.
 */
export function MarketingTags(): React.ReactElement | null {
  const [ask, setAsk] = useState(false);
  /** True when the bar was opened from the footer rather than by a first visit. */
  const [reopened, setReopened] = useState(false);

  useEffect(() => onCookieSettingsOpen(() => {
    setReopened(true);
    setAsk(true);
  }), []);

  useEffect(() => {
    if (!isConfigured.supabase) return;
    let active = true;

    void (async () => {
      const { data, error } = await supabase.rpc('marketing_tags');
      if (!active || error || !data) return;

      const tags = data as Tags;
      loaded = tags;

      const anything = tags.meta_pixel_id || tags.google_ads_id || tags.google_analytics_id;
      if (!anything) return;

      if (!tags.consent_required || hasConsent()) {
        inject(tags);
        return;
      }

      if (!consentAnswered()) setAsk(true);
    })();

    return () => { active = false; };
  }, []);

  if (!ask) return null;

  const anythingConfigured = Boolean(
    loaded?.meta_pixel_id || loaded?.google_ads_id || loaded?.google_analytics_id,
  );

  return (
    <View style={styles.bar} accessibilityRole="alert">
      <Text style={styles.text}>
        {anythingConfigured
          ? 'Meriame návštevnosť cez Metu a Google, aby sme vedeli, ktoré eventy ľudí naozaj zaujímajú. Bez tvojho súhlasu sa nenačíta nič.'
          : 'Meracie nástroje na tomto nasadení zapnuté nie sú, takže sa nenačítava nič. Nevyhnutné cookies — prihlásenie a košík — bežia vždy.'}
        {reopened && consentAnswered()
          ? ` Tvoja doterajšia odpoveď: ${hasConsent() ? 'súhlas' : 'odmietnutie'}.`
          : ''}
      </Text>

      <View style={styles.actions}>
        <Pressable
          style={[styles.button, styles.decline]}
          onPress={() => { setConsent(false); setAsk(false); }}
        >
          <Text style={styles.declineLabel}>Odmietnuť</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.accept]}
          onPress={() => { setConsent(true); setAsk(false); }}
        >
          <Text style={styles.acceptLabel}>Súhlasím</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.lg,
    maxWidth: 620,
    marginHorizontal: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    flexWrap: 'wrap',
    padding: spacing.lg,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceElevated,
  },
  text: { ...typography.metaSm, color: colors.textSecondary, flex: 1, minWidth: 220 },
  actions: { flexDirection: 'row', gap: spacing.sm },
  button: { paddingHorizontal: spacing.lg, paddingVertical: 10, borderRadius: radius.chip },
  decline: { backgroundColor: colors.surface },
  declineLabel: { ...typography.chip, fontSize: 13, color: colors.textSecondary },
  accept: { backgroundColor: colors.accent },
  acceptLabel: { ...typography.chip, fontSize: 13, color: '#FFFFFF' },
});
