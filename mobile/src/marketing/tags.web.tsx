import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { usePathname } from 'expo-router';

import { supabase } from '@/lib/supabase';
import { useBottomInset } from '@/components/BottomInset';
import { useLayout } from '@/hooks/useLayout';
import { isConfigured } from '@/lib/env';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Meta a Google na webe — aj súhlas, ktorý o nich rozhoduje.
 *
 * Štyri pravidlá, kvôli ktorým tento súbor existuje.
 *
 * 1. ADMIN DÁVA ID, NIE SKRIPT. Zavádzače nižšie sú napísané tu, v kóde, ktorý
 *    ide do appky; z databázy prichádza jedine identifikátor, ktorého tvar už
 *    skontroloval CHECK. Vložená značka by bežala na doméne, kde má každý
 *    návštevník session — preto v admine nie je políčko na vlastný kód.
 *
 * 2. SÚHLAS JE PO KATEGÓRIÁCH, NIE ÁNO/NIE. Analytika, marketing a
 *    personalizácia sa zapínajú zvlášť; nevyhnutné cookies (prihlásenie,
 *    košík, bezpečnosť) nemajú vypínač, lebo bez nich web nefunguje a nie sú
 *    na sledovanie.
 *
 * 3. BEZ SÚHLASU SA NIČ NEUKLADÁ. Google tag sa pri Consent Mode v2 načíta so
 *    všetkým zamietnutým — nenastaví cookie a neidentifikuje nikoho, iba
 *    pošle anonymný signál, z ktorého Google dopočíta konverzie. Meta sa bez
 *    marketingového súhlasu nenačíta vôbec, lebo bezcookie režim nemá a
 *    načítať ju „naprázdno" by nebolo meranie, len kontakt navyše.
 *
 * 4. NEPOSIELAJÚ SA OSOBNÉ ÚDAJE. Udalosti nesú id typu lístka, počet a
 *    hodnotu. Nie e-mail, nie meno, nie id používateľa — a nie kód vstupenky,
 *    ktorý sa skenuje pri vstupe.
 */

/** Nový, kategorizovaný súhlas. */
const CONSENT_KEY = 'blup.cookies';
/**
 * Pôvodné áno/nie. Kto už raz odpovedal, nemá dostať lištu znova len preto, že
 * sme zmenili formát: „yes" znamenalo súhlas so všetkým meraním, „no" odmietnutie.
 */
const LEGACY_KEY = 'blup.marketing.consent';

export interface Consent {
  analytics: boolean;
  marketing: boolean;
  personalization: boolean;
}

const NONE: Consent = { analytics: false, marketing: false, personalization: false };
const ALL: Consent = { analytics: true, marketing: true, personalization: true };

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
  /**
   * Id tej istej udalosti, akú o nej hlási server.
   *
   * Nákup posiela Mete prehliadač aj webhook — pixel časť nákupov stráca na
   * blokovačoch a zatvorených kartách. Bez spoločného id by ich Meta
   * započítala dva, tržby v Ads Manageri by boli dvojnásobné a každé
   * rozhodnutie o rozpočte by stálo na vymyslenom čísle.
   */
  eventId?: string;
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
let googleInjected = false;
let metaInjected = false;
/** Stránka, ktorú si pixel započítal sám pri štarte — nech sa nepočíta dvakrát. */
let metaCountedPath: string | null = null;

// --- uložený súhlas ---------------------------------------------------------

function readStored(): Consent | null {
  try {
    const raw = globalThis.localStorage?.getItem(CONSENT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Consent>;
      return {
        analytics: parsed.analytics === true,
        marketing: parsed.marketing === true,
        personalization: parsed.personalization === true,
      };
    }
    const legacy = globalThis.localStorage?.getItem(LEGACY_KEY);
    if (legacy === 'yes') return ALL;
    if (legacy === 'no') return NONE;
    return null;
  } catch {
    return null;
  }
}

let current: Consent = NONE;

export function consent(): Consent {
  return current;
}

/** True once the visitor has answered — in either format. */
export function consentAnswered(): boolean {
  try {
    return readStored() !== null;
  } catch {
    return true;
  }
}

/** Pre staršie volania, ktoré sa pýtali len „súhlasil?". */
export function hasConsent(): boolean {
  return current.analytics || current.marketing;
}

export function setConsent(next: Consent): void {
  current = next;
  try {
    globalThis.localStorage?.setItem(CONSENT_KEY, JSON.stringify({
      v: 2,
      // Kedy to človek povedal. GDPR chce vedieť preukázať nielen čo, ale aj
      // kedy — a pri zmene znenia je podľa čoho sa znova opýtať.
      at: new Date().toISOString(),
      ...next,
    }));
    // Starý kľúč sa prepisuje tiež, nech sa po návrate na staršiu verziu
    // appky neukáže lišta človeku, ktorý už odpovedal.
    globalThis.localStorage?.setItem(LEGACY_KEY, hasConsent() ? 'yes' : 'no');
  } catch {
    /* private mode: the answer simply does not persist */
  }
  applyConsent();
}

// --- súhlasové signály pre Google a Metu ------------------------------------

/**
 * Consent Mode v2, preložený z našich kategórií do Googlových.
 *
 * `ad_user_data` a `ad_personalization` sú tie dve, ktoré Google od marca 2024
 * vyžaduje od európskych inzerentov; bez nich Google Ads nepočíta modelované
 * konverzie a publiká z webu prestanú rásť.
 */
function googleConsentPayload(state: Consent): Record<string, 'granted' | 'denied'> {
  const yes = (on: boolean) => (on ? 'granted' as const : 'denied' as const);
  return {
    ad_storage: yes(state.marketing),
    ad_user_data: yes(state.marketing),
    ad_personalization: yes(state.marketing),
    analytics_storage: yes(state.analytics),
    functionality_storage: yes(state.personalization),
    personalization_storage: yes(state.personalization),
    // Prihlásenie, košík, ochrana proti zneužitiu. Toto sa nevypína a nie je
    // to na sledovanie.
    security_storage: 'granted',
  };
}

/** Po zmene súhlasu: povedať to tomu, čo už beží, a dotiahnuť, čo pribudlo. */
function applyConsent(): void {
  if (typeof document === 'undefined' || !loaded) return;

  window.gtag?.('consent', 'update', googleConsentPayload(current));

  if (current.marketing) {
    if (loaded.meta_pixel_id) {
      if (!metaInjected) injectMeta(loaded.meta_pixel_id);
      else window.fbq?.('consent', 'grant');
    }
  } else if (metaInjected) {
    window.fbq?.('consent', 'revoke');
  }
}

// --- zavádzače --------------------------------------------------------------

function injectMeta(pixelId: string): void {
  if (metaInjected) return;
  metaInjected = true;

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

  // Poradie je dôležité: `consent` pred `init`, inak pixel stihne nastaviť
  // cookie skôr, než sa dozvie, či smie.
  window.fbq?.('consent', 'grant');
  window.fbq?.('init', pixelId);
  window.fbq?.('track', 'PageView');
  // Pixel si pri štarte započítal stránku, na ktorej práve stojíme. Keby ju
  // o chvíľu poslal aj náš `trackPageView`, Meta by prvú stránku každej
  // návštevy počítala dvakrát — a práve podľa nej sa pomeriava, koľko ľudí
  // z reklamy naozaj prišlo.
  metaCountedPath = typeof location !== 'undefined' ? location.pathname : null;
}

function injectGoogle(ids: string[]): void {
  if (googleInjected) return;
  googleInjected = true;

  const layer: unknown[] = window.dataLayer || [];
  window.dataLayer = layer;

  // gtag must push the real `arguments` object — Google's tag reads it as an
  // array-like, and an arrow function has no `arguments` to give it.
  // eslint-disable-next-line prefer-rest-params, func-style
  const gtag = function gtag() { layer.push(arguments); } as (...args: unknown[]) => void;
  window.gtag = gtag;

  // Súhlas ako PRVÁ vec v dataLayeri, ešte pred načítaním skriptu. Keby prišiel
  // až po ňom, tag by stihol nastaviť cookie v okne, keď ešte nevie, či smie —
  // a to je presne to, čo Consent Mode rieši.
  gtag('consent', 'default', { ...googleConsentPayload(current), wait_for_update: 500 });

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ids[0])}`;
  document.head.appendChild(script);

  gtag('js', new Date());
  for (const id of ids) {
    gtag('config', id, {
      anonymize_ip: true,
      // Stránky si posielame sami pri zmene cesty. BLUP je jednostránková
      // appka: bez tohto by Google videl jedinú stránku na reláciu, tú, na
      // ktorej človek pristál, a všetko ostatné by zmizlo.
      send_page_view: false,
    });
  }
}

/**
 * Čo sa má načítať hneď a čo až so súhlasom.
 *
 * Google ide hore vždy, keď je nakonfigurovaný — so všetkým zamietnutým, kým
 * človek nepovie inak. Toto je Consent Mode v2 v „advanced" režime a je to
 * jediný spôsob, ako od Googlu dostať modelované konverzie za tých, čo súhlas
 * nedali. Žiadnu cookie pritom nenastaví.
 *
 * Meta takýto režim nemá, takže sa načíta až s marketingovým súhlasom.
 */
function injectAllowed(tags: Tags): void {
  if (typeof document === 'undefined') return;

  const googleIds = [tags.google_analytics_id, tags.google_ads_id].filter(Boolean) as string[];
  if (googleIds.length) injectGoogle(googleIds);

  if (tags.meta_pixel_id && (!tags.consent_required || current.marketing)) {
    injectMeta(tags.meta_pixel_id);
  }
}

// --- udalosti ---------------------------------------------------------------

/** Zobrazenie stránky pri prechode v appke. */
export function trackPageView(path: string): void {
  if (!loaded) return;
  window.gtag?.('event', 'page_view', {
    page_path: path,
    page_location: typeof location !== 'undefined' ? location.href : undefined,
    page_title: typeof document !== 'undefined' ? document.title : undefined,
  });

  // Vynuluje sa vždy, nielen pri zhode. Keby sa čistilo len po trafení, stará
  // hodnota by tam ostala visieť a návrat na tú istú stránku o kus neskôr by
  // Meta jednu návštevu nezapočítala.
  const alreadyCounted = metaCountedPath === path;
  metaCountedPath = null;
  if (!alreadyCounted) window.fbq?.('track', 'PageView');
}

/**
 * One event, sent to whichever platforms are on. The names differ per platform,
 * so the mapping lives here rather than at every call site.
 */
export function track(event: TrackEvent, payload: TrackPayload = {}): void {
  if (!loaded) return;

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
    window.fbq?.(
      'track',
      metaName,
      {
        content_type: 'product',
        content_ids: ids,
        content_name: payload.contentName,
        value,
        currency,
      },
      // Štvrtý parameter, nie súčasť dát — Meta deduplikuje práve podľa neho.
      payload.eventId ? { eventID: payload.eventId } : undefined,
    );
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

// --- otvorenie nastavení z pätičky ------------------------------------------

const reopenListeners = new Set<() => void>();

export function openCookieSettings(): void {
  for (const listener of reopenListeners) listener();
}

export function onCookieSettingsOpen(listener: () => void): () => void {
  reopenListeners.add(listener);
  return () => { reopenListeners.delete(listener); };
}

// --- obrazovka --------------------------------------------------------------

type Tab = 'consent' | 'detail' | 'about';

interface Category {
  key: keyof Consent | 'necessary';
  glyph: string;
  title: string;
  body: string;
}

const CATEGORIES: Category[] = [
  {
    key: 'necessary',
    glyph: '🔒',
    title: 'Nevyhnutné cookies',
    body: 'Zabezpečujú základné funkcie webu (košík, prihlasovanie, bezpečnosť). Tieto cookies nie je možné vypnúť.',
  },
  {
    key: 'analytics',
    glyph: '📊',
    title: 'Analytické cookies',
    body: 'Pomáhajú nám pochopiť, ako návštevníci používajú web, aby sme ho mohli zlepšovať (napr. Google Analytics).',
  },
  {
    key: 'marketing',
    glyph: '📣',
    title: 'Marketingové cookies',
    body: 'Používajú sa na zobrazovanie relevantnej reklamy (napr. Google Ads, Meta) a meranie jej účinnosti.',
  },
  {
    key: 'personalization',
    glyph: '👤',
    title: 'Personalizačné cookies',
    body: 'Umožňujú zapamätať si vaše preferencie (napr. jazyk, obľúbené podujatia).',
  },
];

/** Čo konkrétne sa ukladá. Bez tohto je „detailný prehľad" len sľub. */
interface CookieRow {
  name: string;
  provider: string;
  purpose: string;
  life: string;
}

const COOKIE_DETAIL: { category: string; rows: CookieRow[] }[] = [
  {
    category: 'Nevyhnutné',
    rows: [
      { name: 'sb-*-auth-token', provider: 'BLUP (Supabase)', purpose: 'Prihlásenie — bez neho sa pri každom kliknutí odhlásiš.', life: 'do odhlásenia' },
      { name: 'blup.cookies', provider: 'BLUP', purpose: 'Tvoja voľba na tejto obrazovke, aby sme sa nepýtali znova.', life: '12 mesiacov' },
      { name: 'blup.welcome.seen', provider: 'BLUP', purpose: 'Či si už videl úvodnú obrazovku.', life: 'trvalé' },
    ],
  },
  {
    category: 'Analytické',
    rows: [
      { name: '_ga, _ga_*', provider: 'Google Analytics', purpose: 'Odlíši návštevy a relácie, aby sme vedeli, čo ľudia na webe hľadajú.', life: '2 roky' },
    ],
  },
  {
    category: 'Marketingové',
    rows: [
      { name: '_fbp', provider: 'Meta', purpose: 'Meranie účinnosti reklamy a zobrazovanie relevantnejších reklám.', life: '3 mesiace' },
      { name: '_gcl_au', provider: 'Google Ads', purpose: 'Priradenie konverzie ku kampani.', life: '3 mesiace' },
    ],
  },
  {
    category: 'Personalizačné',
    rows: [
      { name: 'blup.location', provider: 'BLUP', purpose: 'Naposledy zvolené mesto, aby si ho nemusel hľadať zakaždým.', life: '12 mesiacov' },
      { name: 'blup.filters', provider: 'BLUP', purpose: 'Zapamätané filtre vo feede.', life: '12 mesiacov' },
    ],
  },
];

/**
 * Mounted once, at the root. Fetches what the admin configured, loads what it
 * may, and asks first.
 *
 * „Zamietnuť všetky" je rovnako veľké a rovnako blízko ako „Prijať všetky“.
 * Odmietnutie, ktoré dá viac práce než súhlas, nie je voľba — a v EÚ to nie je
 * ani súhlas.
 */
export function MarketingTags(): React.ReactElement | null {
  const [ask, setAsk] = useState(false);
  const [tab, setTab] = useState<Tab>('consent');
  const [draft, setDraft] = useState<Consent>(NONE);
  /** Podrobné nastavenie. Lišta dole je to prvé, toto až na vyžiadanie. */
  const [panel, setPanel] = useState(false);
  const bottomInset = useBottomInset();
  const layout = useLayout();
  const pathname = usePathname();
  const lastPath = useRef<string | null>(null);
  /** Až keď vieme, čo je nakonfigurované, má zmysel čokoľvek posielať. */
  const [tagsReady, setTagsReady] = useState(false);

  /**
   * Vysunutie lišty zdola.
   *
   * Nie ozdoba: keď sa niečo zjaví na stránke bez pohybu, oko to prehliadne.
   * Krátky pohyb zdola povie, že to prišlo a že to niečo chce — a zároveň to
   * nie je skok, ktorý by posunul obsah pod prstom.
   */
  const slide = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!ask || panel) return;
    Animated.timing(slide, {
      toValue: 1,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [ask, panel, slide]);

  // Z pätičky sa otvára rovno podrobné nastavenie — kto naň klikol, nehľadá
  // lištu s „prijať/zamietnuť", ale chce prepnúť konkrétnu kategóriu.
  useEffect(() => onCookieSettingsOpen(() => {
    setDraft(current);
    setTab('consent');
    setPanel(true);
    setAsk(true);
  }), []);

  // Asked once, on the first visit, whatever is configured.
  //
  // Deliberately after mount, and deliberately not a lazy initial state. The web
  // build is a static export: the first render happens at build time in Node,
  // where there is no localStorage and consentAnswered() therefore answers
  // "already asked". Deciding this during render would bake that answer into the
  // HTML and then contradict it on hydration.
  useEffect(() => {
    const stored = readStored();
    if (stored) current = stored;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    else setAsk(true);
  }, []);

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

      if (!tags.consent_required) current = ALL;
      injectAllowed(tags);
      setTagsReady(true);
    })();

    return () => { active = false; };
  }, []);

  /**
   * Zobrazenie stránky pri prechode.
   *
   * BLUP je jednostránková appka — po prvom načítaní sa URL mení bez toho, aby
   * sa stránka znova načítala, takže Google aj Meta by videli jedinú stránku na
   * reláciu. Prvé zavolanie sa preskakuje len vtedy, keď ešte nie je čo poslať.
   */
  useEffect(() => {
    // `tagsReady` tu nie je kozmetika. Bez neho sa prvé spustenie trafilo do
    // okna, keď `marketing_tags` ešte nedobehlo: `trackPageView` sa ticho
    // vrátil, cesta sa už zapísala ako odoslaná a vstupná stránka — tá
    // najdôležitejšia, lebo na ňu vedie reklama — sa nezapočítala nikdy.
    if (!tagsReady || !pathname || pathname === lastPath.current) return;
    lastPath.current = pathname;
    trackPageView(pathname);
  }, [pathname, tagsReady]);

  const save = useCallback((next: Consent) => {
    setConsent(next);
    if (loaded) injectAllowed(loaded);
    setPanel(false);
    setAsk(false);
  }, []);

  if (!ask) return null;

  const toggle = (key: keyof Consent) =>
    setDraft((value) => ({ ...value, [key]: !value[key] }));

  /**
   * Lišta dole — prvé, čo človek uvidí.
   *
   * Nezakrýva stránku a nečaká na odpoveď, aby sa dalo pozerať na eventy;
   * okno cez celú obrazovku v tej chvíli iba stojí v ceste. Prijatie je
   * hlavné tlačidlo, lebo väčšina ľudí povolí a nemá dôvod hľadať ako.
   *
   * „Zamietnuť" je napriek tomu plnohodnotné tlačidlo rovnakej veľkosti hneď
   * vedľa. Keby bolo menšie, šedšie alebo schované za odkazom, nebol by to
   * súhlas — a to nie je názor, to je dôvod, prečo sa takéto lišty pokutujú.
   */
  if (!panel) {
    return (
      <Animated.View
        accessibilityRole="alert"
        style={[
          styles.bar,
          /**
           * Nad spodnou navigáciou, nie cez ňu.
           *
           * `useBottomInset()` na to nestačí a stálo to jednu nahlásenú chybu:
           * vracia nulu na obrazovkách, ktoré si žiadnu rezervu nepýtajú, takže
           * lišta sadla rovno na spodný okraj — a tam je na telefóne lišta
           * s kartami. „Zamietnuť" skončilo presne na tlačidle SWAP a kým
           * človek neodpovedal, nedal sa otvoriť.
           *
           * 92 px je výška tej lišty aj s medzerou, rovnaké číslo ako používa
           * bublina košíka; `bottomInset` sa pripočítava navyše tam, kde si
           * obrazovka pýta vlastnú rezervu.
           */
          {
            bottom: (layout.isDesktop ? spacing.lg : 92)
              + (bottomInset > 0 ? bottomInset + spacing.md : 0),
          },
          {
            opacity: slide,
            transform: [{
              translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }),
            }],
          },
        ]}
      >
        <View style={styles.barText}>
          <Text style={styles.barTitle}>🍪 Pomôž nám BLUP zlepšovať</Text>
          <Text style={styles.barBody}>
            Nevyhnutné cookies — prihlásenie a košík — bežia vždy. S tými ostatnými vidíme,
            čo ľudia na BLUPe hľadajú a ktoré eventy im unikli, takže ti vieme lepšie radiť.
            Zmeniť sa to dá kedykoľvek v pätičke.
          </Text>
        </View>

        <View style={styles.barActions}>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.barButton, styles.primary, pressed && styles.pressed]}
            onPress={() => save(ALL)}
          >
            <Text style={styles.primaryLabel}>Prijať všetky</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.barButton, styles.secondary, pressed && styles.pressed]}
            onPress={() => save(NONE)}
          >
            <Text style={styles.secondaryLabel}>Zamietnuť</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={styles.barLink}
            onPress={() => { setDraft(current); setTab('consent'); setPanel(true); }}
          >
            <Text style={styles.barLinkLabel}>Nastaviť</Text>
          </Pressable>
        </View>
      </Animated.View>
    );
  }

  return (
    <Modal transparent animationType="fade" visible onRequestClose={() => setPanel(false)}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} accessibilityRole="alert">
          <View style={styles.head}>
            <Text style={styles.title}>Nastavenie cookies</Text>
            {/* Zavrieť vedie späť na lištu, keď človek ešte neodpovedal, a
                celkom preč, keď už odpovedal. Zavretie nie je odpoveď a nič
                sa ním neukladá. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Zavrieť"
              onPress={() => { setPanel(false); if (consentAnswered()) setAsk(false); }}
              style={styles.close}
            >
              <Text style={styles.closeGlyph}>✕</Text>
            </Pressable>
          </View>

          <View style={styles.tabs}>
            {([
              ['consent', 'Súhlas'],
              ['detail', 'Detailný prehľad'],
              ['about', 'O cookies'],
            ] as [Tab, string][]).map(([key, label]) => (
              <Pressable
                key={key}
                accessibilityRole="button"
                onPress={() => setTab(key)}
                style={[styles.tab, tab === key && styles.tabOn]}
              >
                <Text style={[styles.tabLabel, tab === key && styles.tabLabelOn]}>{label}</Text>
              </Pressable>
            ))}
          </View>

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            {tab === 'consent' ? (
              <>
                <Text style={styles.intro}>
                  Vyberte, aké kategórie cookies nám chcete povoliť. Nevyhnutné cookies sú potrebné
                  na správne fungovanie webu a nie je možné ich vypnúť. Ostatné kategórie môžete
                  povoliť podľa vašich preferencií.
                </Text>

                {CATEGORIES.map((category) => {
                  const fixed = category.key === 'necessary';
                  const on = fixed ? true : draft[category.key as keyof Consent];
                  return (
                    <View key={category.key} style={styles.row}>
                      <Text style={styles.glyph}>{category.glyph}</Text>
                      <View style={styles.rowText}>
                        <Text style={styles.rowTitle}>{category.title}</Text>
                        <Text style={styles.rowBody}>{category.body}</Text>
                      </View>
                      {fixed ? (
                        <Text style={styles.always}>Vždy aktívne</Text>
                      ) : (
                        <Pressable
                          accessibilityRole="switch"
                          // `aria-checked` natvrdo, nie len cez
                          // `accessibilityState`: react-native-web ho v tejto
                          // verzii na web nepreloží, takže z prepínača ostane
                          // role="switch" bez stavu — čítačka obrazovky
                          // povie „prepínač" a nepovie, či je zapnutý. Pri
                          // obrazovke o súhlase to nie je detail.
                          aria-checked={on}
                          accessibilityState={{ checked: on }}
                          accessibilityLabel={category.title}
                          onPress={() => toggle(category.key as keyof Consent)}
                          style={[styles.switch, on && styles.switchOn]}
                        >
                          <View style={[styles.knob, on && styles.knobOn]} />
                        </Pressable>
                      )}
                    </View>
                  );
                })}
              </>
            ) : null}

            {tab === 'detail' ? (
              <>
                <Text style={styles.intro}>
                  Tu nájdete podrobné informácie o jednotlivých cookies, ich účele, poskytovateľoch
                  a dobe uchovávania.
                </Text>
                {COOKIE_DETAIL.map((group) => (
                  <View key={group.category} style={styles.group}>
                    <Text style={styles.groupTitle}>{group.category}</Text>
                    {group.rows.map((cookie) => (
                      <View key={cookie.name} style={styles.detailRow}>
                        <Text style={styles.cookieName}>{cookie.name}</Text>
                        <Text style={styles.rowBody}>{cookie.purpose}</Text>
                        <Text style={styles.cookieMeta}>
                          {cookie.provider} · {cookie.life}
                        </Text>
                      </View>
                    ))}
                  </View>
                ))}
              </>
            ) : null}

            {tab === 'about' ? (
              <>
                <Text style={styles.intro}>
                  Cookies sú malé súbory, ktoré si web uloží vo vašom prehliadači. Niektoré sú
                  nutné na to, aby stránka vôbec fungovala — bez nich by vás po prihlásení hneď
                  odhlásilo a košík by sa vyprázdnil pri každom kliknutí.
                </Text>
                <Text style={styles.intro}>
                  Ostatné nám hovoria, čo na BLUPe ľudia hľadajú a ktorá reklama má zmysel. Bez
                  vášho súhlasu sa nenastavia a tretím stranám sa z nich nič neposiela. Voľbu
                  môžete kedykoľvek zmeniť v pätičke pod odkazom „Aktualizovať nastavenia cookies".
                </Text>
                <Text style={styles.intro}>
                  Nikdy neposielame meno, e-mail ani kód vašej vstupenky. Posiela sa, aký typ
                  lístka ste si pozreli alebo kúpili, koľko kusov a za koľko.
                </Text>
              </>
            ) : null}
          </ScrollView>

          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              style={[styles.button, styles.primary]}
              onPress={() => save(draft)}
            >
              <Text style={styles.primaryLabel}>Uložiť moje nastavenie</Text>
            </Pressable>

            <View style={styles.actionsRow}>
              <Pressable
                accessibilityRole="button"
                style={[styles.button, styles.secondary, styles.half]}
                onPress={() => save(NONE)}
              >
                <Text style={styles.secondaryLabel}>Zamietnuť všetky</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={[styles.button, styles.secondary, styles.half]}
                onPress={() => save(ALL)}
              >
                <Text style={styles.secondaryLabel}>Prijať všetky</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  /**
   * Lišta dole.
   *
   * `position: fixed`, nie `absolute`: appka scrolluje vo vlastnom kontajneri a
   * absolútne umiestnená lišta by s ním odišla hore. `zIndex` vyššie než má
   * bublina košíka (40), aby sa neprekrývali.
   */
  bar: {
    position: 'fixed' as 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    maxWidth: 760,
    marginHorizontal: 'auto',
    zIndex: 60,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceElevated,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
  },
  // minWidth 0, aby sa text pri úzkom okne zalomil v sebe a nevytlačil
  // tlačidlá mimo lišty.
  barText: { flex: 1, minWidth: 240, gap: 4 },
  barTitle: { ...typography.bodyStrong, color: colors.text },
  barBody: { ...typography.metaSm, color: colors.textSecondary },
  barActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  barButton: {
    height: 44,
    minWidth: 128,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  barLink: { paddingHorizontal: spacing.sm, paddingVertical: spacing.sm },
  barLinkLabel: { ...typography.captionStrong, color: colors.textSecondary },
  pressed: { opacity: 0.9 },

  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  sheet: {
    width: '100%',
    maxWidth: 680,
    maxHeight: '90%',
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceElevated,
    overflow: 'hidden',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    paddingBottom: spacing.md,
  },
  title: { ...typography.subheading, color: colors.text },
  close: { padding: spacing.xs },
  closeGlyph: { ...typography.body, color: colors.textSecondary },

  tabs: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tab: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabOn: { borderBottomColor: colors.accent },
  tabLabel: { ...typography.caption, color: colors.textSecondary },
  tabLabelOn: { color: colors.text },

  body: { maxHeight: 420 },
  bodyContent: { padding: spacing.lg, gap: spacing.md },
  intro: { ...typography.metaSm, color: colors.textSecondary },

  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  glyph: { fontSize: 18 },
  // minWidth 0, aby dlhý popis zmenšil sám seba a nevytlačil vypínač z riadku.
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { ...typography.bodyStrong, color: colors.text },
  rowBody: { ...typography.metaSm, color: colors.textSecondary },
  always: { ...typography.metaSm, color: colors.textSecondary, flexShrink: 0 },

  switch: {
    width: 44,
    height: 26,
    borderRadius: 13,
    padding: 3,
    backgroundColor: colors.surfaceElevated2,
    borderWidth: 1,
    borderColor: colors.border,
    flexShrink: 0,
  },
  switchOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  knob: { width: 18, height: 18, borderRadius: 9, backgroundColor: colors.textSecondary },
  knobOn: { backgroundColor: '#FFFFFF', marginLeft: 18 },

  group: { gap: spacing.sm },
  groupTitle: { ...typography.captionStrong, color: colors.text },
  detailRow: {
    gap: 2,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  cookieName: { ...typography.captionStrong, color: colors.text },
  cookieMeta: { ...typography.metaSm, color: colors.textSecondary },

  actions: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  actionsRow: { flexDirection: 'row', gap: spacing.sm },
  half: { flex: 1 },
  button: {
    height: 46,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  primary: { backgroundColor: colors.accent },
  primaryLabel: { ...typography.captionStrong, color: '#FFFFFF' },
  secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  secondaryLabel: { ...typography.captionStrong, color: colors.text },
});
