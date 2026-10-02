import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { loadStripe, type Stripe, type StripeElements } from '@stripe/stripe-js';

import { Button, Caption, Notice } from '@/components/ui';
import { env } from '@/lib/env';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Platba priamo na BLUPe.
 *
 * Doteraz web odskakoval na hostovanú stránku Stripu: fungovalo to, ale človek
 * v polovici nákupu opustil BLUP a vrátil sa naň až s hotovou platbou. Tu sa
 * karta vypĺňa na mieste.
 *
 * Čo sa tým NEmení a meniť nesmie:
 *   — cenu naďalej počíta databáza, prehliadač pošle iba to, čo kupuje,
 *   — zaplatené je to až vtedy, keď to povie overený webhook; úspešné
 *     `confirmPayment` je sľub, nie doklad,
 *   — číslo karty sa nedotkne našej domény. Payment Element je Stripe v
 *     iframe, my vidíme iba to, či to prešlo.
 *
 * Objednávka vzniká až po stlačení „Zaplatiť": Element beží v odloženom režime
 * (`mode: 'payment'` so sumou), takže kým sa človek rozmýšľa, nikomu sa
 * neblokujú vstupenky a pri návrate o krok späť nezostáva viseť objednávka,
 * ktorú nikto nezaplatí.
 */

/** Jedna inštancia na celý beh stránky — `loadStripe` ťahá skript zo Stripu. */
let stripePromise: Promise<Stripe | null> | null = null;
const getStripe = (): Promise<Stripe | null> => {
  if (!stripePromise) stripePromise = loadStripe(env.stripePublishableKey);
  return stripePromise;
};

export interface IntentHandles {
  clientSecret: string;
  returnUrl: string;
}

export interface PaymentFormProps {
  /** Koľko sa platí, v centoch. Musí byť > 0 — zadarmo sa cez kartu neplatí. */
  amountCents: number;
  currency: string;
  payLabel: string;
  disabled?: boolean;
  /**
   * Založí objednávku a vráti tajomstvo platby. Volá sa až po stlačení
   * „Zaplatiť" a po tom, čo Element potvrdí, že údaje sú vyplnené.
   */
  createIntent: () => Promise<IntentHandles>;
  /** Platba prešla cez banku. Vstupenka ešte nie je — na tú čaká webhook. */
  onAuthorized: () => void;
  onError: (message: string) => void;
}

export function PaymentForm({
  amountCents, currency, payLabel, disabled, createIntent, onAuthorized, onError,
}: PaymentFormProps) {
  const host = useRef<View | null>(null);
  const stripeRef = useRef<Stripe | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const [ready, setReady] = useState(false);
  // Časovač nižšie beží mimo vykresľovania a `ready` zo stavu by v ňom bolo
  // zamrznuté na hodnote z času, keď sa nastavoval.
  const readyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [mountError, setMountError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let mounted: { destroy(): void } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Pri zmene sumy sa Element skladá nanovo, takže aj „už je pripravený"
    // musí ísť späť na nulu — inak by druhý formulár zdedil pripravenosť toho
    // prvého a tlačidlo „Zaplatiť" by sa dalo stlačiť nad prázdnym poľom.
    readyRef.current = false;
    setReady(false);
    setMountError(null);

    void (async () => {
      try {
        const stripe = await getStripe();
        if (cancelled) return;
        if (!stripe) {
          setMountError('Platobný formulár sa nepodarilo načítať. Skús obnoviť stránku.');
          return;
        }
        stripeRef.current = stripe;

        const elements = stripe.elements({
          mode: 'payment',
          amount: amountCents,
          currency: currency.toLowerCase(),
          // Formulár má vyzerať ako zvyšok BLUPu, nie ako cudzia stránka
          // vlepená do našej. Farby berieme z tém, nie ručne.
          appearance: {
            theme: 'night',
            variables: {
              colorPrimary: colors.accent,
              colorBackground: colors.surface,
              colorText: colors.text,
              colorDanger: colors.danger,
              borderRadius: `${radius.md}px`,
              fontSizeBase: `${typography.body.fontSize}px`,
            },
          },
        });
        elementsRef.current = elements;

        const payment = elements.create('payment', { layout: 'tabs' });
        // `host.current` je na webe skutočný DOM uzol — react-native-web
        // renderuje View ako <div>. Stripe si doň vloží vlastný iframe.
        const node = host.current as unknown as HTMLElement | null;
        if (!node) return;
        payment.mount(node);
        mounted = payment;
        payment.on('ready', () => {
          if (cancelled) return;
          readyRef.current = true;
          setReady(true);
        });
        // Keď sa formulár nenačíta, musí to byť vidieť. Bez tejto poistky
        // zostal na stránke prázdny obdĺžnik, pod ním „Načítavam…" a vypnuté
        // tlačidlo — teda stránka, ktorá sa tvári, že ešte chvíľu a bude to,
        // hoci už nebude. Pätnásť sekúnd je dosť aj pre pomalú linku.
        timer = setTimeout(() => {
          if (!cancelled && !readyRef.current) {
            setMountError(
              'Platobný formulár sa nenačítal. Skús obnoviť stránku alebo iný prehliadač — '
              + 'ak to nepomôže, napíš nám a objednávku dokončíme.',
            );
          }
        }, 15_000);
      } catch {
        if (!cancelled) {
          setMountError('Platobný formulár sa nepodarilo načítať. Skús obnoviť stránku.');
        }
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      mounted?.destroy();
    };
    // Suma sa v tomto kroku už nemení — kto ju chce zmeniť, vracia sa o krok
    // späť a Element sa vytvorí nanovo. Preto tu nie je `elements.update()`.
  }, [amountCents, currency]);

  const pay = async () => {
    const stripe = stripeRef.current;
    const elements = elementsRef.current;
    if (!stripe || !elements) return;

    setBusy(true);
    try {
      // 1. Najprv nech Element povie, či je vyplnený. Bez tohto by sme založili
      //    objednávku aj pre kartu, ktorej chýba dátum platnosti.
      const submitted = await elements.submit();
      if (submitted.error) {
        onError(submitted.error.message ?? 'Skontroluj údaje o karte.');
        return;
      }

      // 2. Až teraz vzniká objednávka a s ňou cena — na serveri.
      const { clientSecret, returnUrl } = await createIntent();

      // 3. `redirect: 'if_required'` drží človeka na BLUPe pri bežnej karte
      //    a pustí ho do banky iba vtedy, keď si to banka vypýta (3-D Secure).
      const result = await stripe.confirmPayment({
        elements,
        clientSecret,
        confirmParams: { return_url: returnUrl },
        redirect: 'if_required',
      });

      if (result.error) {
        onError(result.error.message ?? 'Platba neprešla. Skús to znova alebo inou kartou.');
        return;
      }

      onAuthorized();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Platba neprešla.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.wrapper}>
      {mountError ? (
        <Notice tone="danger" title="Platobný formulár" body={mountError} />
      ) : null}

      {/* Keď sa formulár nenačítal, nie je čo držať — rezerva výšky by nad
          tlačidlom nechala dlaň prázdneho miesta a vyzeralo by to ako ďalšia
          chyba. */}
      <View ref={host} style={mountError ? undefined : styles.host} />

      {!ready && !mountError ? (
        <Caption style={styles.loading}>Načítavam platobný formulár…</Caption>
      ) : null}

      <Button
        title={payLabel}
        onPress={pay}
        loading={busy}
        disabled={disabled || !ready || busy}
        full
      />

      <Caption style={styles.trust}>
        Kartu spracúva Stripe. Jej číslo sa k nám nedostane.
      </Caption>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: spacing.md },
  // minHeight, aby stránka pri načítaní formulára neposkočila — Stripe si
  // iframe doťahuje a bez rezervy by tlačidlo „Zaplatiť" skočilo nadol práve
  // vtedy, keď naň človek mieri.
  host: { minHeight: 220 },
  loading: { textAlign: 'center' },
  trust: { textAlign: 'center' },
});
