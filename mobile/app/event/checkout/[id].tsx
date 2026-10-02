import React, { useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';


import { getEvent } from '@/api/events';
import {
  markTicketPurchaseSignal, previewPromoCode, quoteOrder, type PromoPreview,
} from '@/api/tickets';
import { useAuth } from '@/auth/AuthProvider';
import { useRequireAuth } from '@/auth/useRequireAuth';
import { isConfigured } from '@/lib/env';
import { useStripeBridge } from '@/payments/stripe';
import { PaymentForm } from '@/payments/PaymentForm';
import {
  canTakePayment, payForTickets, requiresPublishableKey, startInlineTicketPayment,
  supportsInlinePayment, unavailableMessage,
  type GuestDetails,
} from '@/payments/checkout';
import { suggestAddresses } from '@/maps/geocode';
import { messageFor } from '@/lib/errors';
import { formatMoney, formatPrice, vatIncludedLabel } from '@/lib/format';
import {
  Body, Button, Caption, Divider, ErrorState, Input, LoadingState, Mono, Notice, Screen,
  SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

type Stage = 'form' | 'paying' | 'confirming' | 'done';
/** Kroky nákupu. Ktoré z nich existujú, rozhoduje to, či je kto prihlásený. */
type Step = 'ticket' | 'details' | 'pay';

const PROMO_REASON: Record<string, string> = {
  PROMO_NOT_FOUND: 'Taký kód pre tento event neexistuje.',
  PROMO_EXPIRED: 'Platnosť kódu už vypršala.',
  PROMO_NOT_STARTED: 'Kód ešte nie je aktívny.',
  PROMO_EXHAUSTED: 'Kód už bol vyčerpaný.',
};

function promoReason(reason?: string): string {
  return (reason && PROMO_REASON[reason]) || 'Skús iný kód.';
}

/**
 * Pokladňa.
 *
 * Jedna cesta, tri zastávky a na každej je vidno, kde človek je a čo ho ešte
 * čaká: vyber vstupenku → povedz, kam ju poslať → zaplať. Predtým to bola
 * jedna dlhá stránka, na ktorej sa naraz pýtalo na množstvo, zľavový kód,
 * meno, e-mail aj mesto — a tlačidlo „Zaplatiť" bolo až pod tým všetkým.
 *
 * Na webe sa karta vypĺňa priamo tu. Nákup sa tým nemení v tom, na čom záleží:
 *   1. cenu počíta databáza, nie táto obrazovka,
 *   2. objednávka vzniká až po stlačení „Zaplatiť",
 *   3. vstupenku vydá až overený webhook — úspešná platba je sľub, nie doklad,
 *   4. návratová stránka počká, kým vstupenka naozaj existuje.
 *
 * Zámerne tu NIE JE plávajúca lišta s druhým tlačidlom „Zaplatiť". Dve
 * tlačidlá na to isté sú presne tá nejednoznačnosť, ktorú sme z eventu
 * vyhadzovali; v každom kroku je práve jedno a je na konci kroku.
 */
export default function CheckoutScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isGuest } = useAuth();
  const { requireAuth } = useRequireAuth();
  const { initPaymentSheet, presentPaymentSheet } = useStripeBridge();

  const [ticketTypeId, setTicketTypeId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [stage, setStage] = useState<Stage>('form');
  const [step, setStep] = useState<Step>('ticket');
  const [error, setError] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [promoOpen, setPromoOpen] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const [promo, setPromo] = useState<PromoPreview | null>(null);
  const [checkingPromo, setCheckingPromo] = useState(false);

  // Buying without an account. Only the three things a ticket needs; anything
  // more would be a registration form wearing a different hat.
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [guestCity, setGuestCity] = useState('');

  /** Objednávka založená pri stlačení „Zaplatiť", aj s kľúčom pre hosťa. */
  const started_ = useRef<{ order?: string; token?: string | null } | null>(null);

  const event = useQuery({
    queryKey: ['event', id],
    queryFn: () => getEvent(id!),
    enabled: Boolean(id),
  });

  const ticketTypes = event.data?.ticket_types ?? [];
  const selected = ticketTypes.find((type) => type.id === ticketTypeId) ?? ticketTypes[0];

  // The price comes from the database, never from arithmetic done here. The
  // quote is the same function that will charge the card, so what this screen
  // shows and what the buyer pays are the same number by construction.
  const appliedPromo = promo?.valid ? promoCode : null;
  const quote = useQuery({
    queryKey: ['order-quote', selected?.id, quantity, appliedPromo],
    queryFn: () => quoteOrder(selected!.id, quantity, appliedPromo),
    enabled: Boolean(selected?.id),
  });
  const maxQuantity = selected
    ? Math.min(selected.max_per_order, selected.quantity_total - selected.quantity_sold)
    : 1;

  const applyPromo = async () => {
    if (!selected || !id) return;
    setError(null);
    setCheckingPromo(true);
    try {
      const result = await previewPromoCode(id, promoCode, selected.price_cents * quantity);
      setPromo(result);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setCheckingPromo(false);
    }
  };

  /**
   * Buying without an account.
   *
   * Making somebody register before they can pay is the most expensive sentence
   * on the site. A ticket has never actually needed an account — it needs a name
   * to print, an address to reach, and a QR that scans — so those three are what
   * is asked for, and nothing else.
   *
   * Only in a browser. In the app there is a sign-in screen in front of this
   * anyway, and Apple's own rules make an anonymous purchase flow there a
   * different conversation.
   */
  const guestCheckout = Platform.OS === 'web';
  const needsDetails = isGuest && guestCheckout;

  const guestReady =
    guestName.trim().length >= 2
    && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(guestEmail.trim())
    && guestCity.trim().length >= 2;

  /**
   * Zastávky tejto pokladne.
   *
   * Prihlásený človek nemá čo vypĺňať, tak krok „Údaje" ani nevidí — ukázať mu
   * prázdny krok len preto, aby ukazovateľ mal tri políčka, je predstieranie
   * postupu.
   */
  const steps: { key: Step; label: string }[] = [
    { key: 'ticket', label: 'Vstupenka' },
    ...(needsDetails ? [{ key: 'details' as Step, label: 'Údaje' }] : []),
    { key: 'pay', label: 'Platba' },
  ];
  const stepIndex = Math.max(0, steps.findIndex((entry) => entry.key === step));

  const goBack = () => {
    setError(null);
    const previous = steps[stepIndex - 1];
    if (previous) setStep(previous.key);
    else router.back();
  };

  /**
   * The town, as a point.
   *
   * Resolved quietly and never in the way: the purchase must not fail because a
   * geocoder was slow or a village is spelled unusually. Without coordinates the
   * town is still a row in the organizer's list — it just has no dot on the map.
   */
  const locateCity = async (city: string): Promise<{ latitude: number; longitude: number } | null> => {
    try {
      const hits = await suggestAddresses(city, { limit: 1 });
      const hit = hits[0];
      return hit ? { latitude: hit.latitude, longitude: hit.longitude } : null;
    } catch {
      return null;
    }
  };

  /** Údaje hosťa v tvare, v akom ich chce server. Null pre prihláseného. */
  const guestDetails = async (): Promise<GuestDetails | null> => {
    if (!needsDetails) return null;
    const point = await locateCity(guestCity.trim());
    return {
      name: guestName.trim(),
      email: guestEmail.trim(),
      city: guestCity.trim(),
      latitude: point?.latitude ?? null,
      longitude: point?.longitude ?? null,
    };
  };

  /** Kam ide človek po tom, čo banka platbu pustila. */
  const toReturnPage = (order?: string, token?: string | null) => {
    void markTicketPurchaseSignal(id!);
    if (order && token) router.replace(`/checkout/return?order=${order}&token=${token}`);
    else if (order) router.replace(`/checkout/return?order=${order}`);
    else setStage('done');
  };

  /**
   * Webová platba: objednávka vzniká až tu, po stlačení „Zaplatiť".
   *
   * Vracia tajomstvo, ktorým Payment Element potvrdí kartu. Keď medzitým cena
   * spadla na nulu (zľavový kód), objednávka je už vybavená a nie je čo
   * potvrdzovať — vtedy sa ide rovno na vstupenku.
   */
  const createInlineIntent = async () => {
    const guest = await guestDetails();
    const started = await startInlineTicketPayment(
      selected!.id,
      quantity,
      promo?.valid ? promoCode : null,
      guest,
    );

    if (started.status === 'succeeded') {
      toReturnPage(started.orderId, started.claimToken);
      throw new Error('Vstupenka je vybavená — otváram ju.');
    }

    if (started.orderId) setOrderId(started.orderId);
    // Kľúč k vstupenke pre hosťa. Drží sa v ref, nie v stave: medzi založením
    // objednávky a potvrdením karty stojí banka a `onAuthorized` ho potrebuje
    // hneď, nie až po ďalšom vykreslení.
    started_.current = { order: started.orderId, token: started.claimToken ?? null };
    return { clientSecret: started.clientSecret, returnUrl: started.returnUrl };
  };

  const onAuthorized = () => {
    toReturnPage(started_.current?.order, started_.current?.token);
  };

  /**
   * Natívna platba (PaymentSheet) a nulová objednávka.
   *
   * Na webe touto cestou ide už len vstupenka zadarmo: platená sa potvrdzuje
   * v Payment Elemente vyššie.
   */
  const pay = async () => {
    if (!selected) return;

    let guest: GuestDetails | null = null;

    if (isGuest) {
      if (!guestCheckout) {
        if (!requireAuth('Vstupenka musí patriť účtu — pošleme ti ju e-mailom aj do appky.', () => {})) {
          return;
        }
      } else {
        if (!guestReady) {
          setError('Doplň meno, e-mail a mesto — na e-mail ti príde vstupenka.');
          return;
        }
        guest = await guestDetails();
      }
    }

    setError(null);
    setStage('paying');

    try {
      const result = await payForTickets(
        selected.id,
        quantity,
        promo?.valid ? promoCode : null,
        {
          initPaymentSheet,
          presentPaymentSheet,
          merchantName: event.data?.organization?.name ?? 'BLUP',
        },
        guest,
      );

      if (result.orderId) setOrderId(result.orderId);

      // On web the browser is already navigating to Stripe; leave the screen in
      // its paying state rather than flashing a result nobody will read.
      if (result.status === 'redirecting') return;

      if (result.status === 'cancelled') {
        setStage('form');
        return;
      }

      void markTicketPurchaseSignal(id!);

      if (guest && result.orderId && result.claimToken) {
        router.replace(`/checkout/return?order=${result.orderId}&token=${result.claimToken}`);
        return;
      }

      setStage('done');
    } catch (caught) {
      setError(messageFor(caught));
      setStage('form');
    }
  };

  if (event.isLoading) return <Screen><LoadingState /></Screen>;

  if (event.isError || !event.data) {
    return (
      <Screen>
        <ErrorState message={messageFor(event.error)} onRetry={() => void event.refetch()} />
      </Screen>
    );
  }

  if (ticketTypes.length === 0) {
    return (
      <Screen scroll>
        <Notice
          tone="warning"
          title="Žiadne vstupenky v predaji"
          body="Tento event zatiaľ nemá žiadne typy vstupeniek."
        />
        <Button title="Späť na event" variant="secondary" onPress={() => router.back()} />
      </Screen>
    );
  }

  if (stage === 'done') {
    return (
      <Screen scroll>
        <View style={styles.success}>
          <Text style={styles.successEmoji}>🎫</Text>
          <Text style={styles.successTitle}>Si dnu</Text>
          <Body muted style={styles.successBody}>
            {quantity > 1 ? `${quantity} vstupenky sú` : 'Vstupenka je'} potvrdená a uložená v tvojom
            účte. Pri vstupe ukáž QR kód.
          </Body>

          <Button title="Zobraziť vstupenku" onPress={() => router.replace('/tickets')} />
          <Button title="Späť na event" variant="ghost" onPress={() => router.replace(`/event/${id}`)} />
        </View>
      </Screen>
    );
  }

  if (stage === 'confirming') {
    return (
      <Screen>
        <LoadingState label="Potvrdzujem platbu s bankou…" />
        <Caption style={styles.confirmHint}>
          Kým vydáme vstupenku, čakáme na potvrdenie od platobnej brány. Toto je tá poctivá časť —
          trvá pár sekúnd.
        </Caption>
      </Screen>
    );
  }

  const currency = quote.data?.currency ?? selected?.currency ?? 'EUR';
  // While the quote is in flight, fall back to the list price so the screen
  // never shows a blank total. Every fee line below is rendered only from the
  // quote, so a fallback can under-state but never invent a charge.
  const subtotal = quote.data?.subtotal_cents ?? (selected?.price_cents ?? 0) * quantity;
  const discount = quote.data?.discount_cents ?? 0;
  const archiveFee = quote.data?.archive_fee_payer === 'buyer'
    ? quote.data.archive_fee_cents
    : 0;
  const payable = quote.data?.buyer_total_cents ?? Math.max(subtotal - discount, 0);

  // One number to pay; this only says VAT is already in it.
  const vatLabel = vatIncludedLabel(
    event.data.organization?.is_vat_payer,
    event.data.organization?.vat_rate_bps,
  );

  const paymentsBlocked = payable > 0
    && (!canTakePayment() || (requiresPublishableKey && !isConfigured.stripe));
  // Inline formulár potrebuje verejný kľúč v prehliadači. Bez neho sa nedá
  // vykresliť a je poctivejšie to povedať, než ukázať prázdny rámček.
  const inlineReady = supportsInlinePayment && isConfigured.stripe && payable > 0;

  /** Súhrn ceny. Na prvom kroku sa mení, na poslednom už len pripomína. */
  const summary = (
    <>
      {discount > 0 ? (
        <>
          <View style={styles.summaryRow}>
            <Body muted>Medzisúčet</Body>
            <Body muted>{formatMoney(subtotal, currency)}</Body>
          </View>
          <View style={styles.summaryRow}>
            <Mono style={styles.discountLabel}>ZĽAVA {promoCode}</Mono>
            <Body style={styles.discountValue}>− {formatMoney(discount, currency)}</Body>
          </View>
        </>
      ) : (
        <View style={styles.summaryRow}>
          <Body muted>
            {quantity} × {selected ? formatPrice(selected.price_cents, selected.currency) : '—'}
          </Body>
          <Body>{formatMoney(subtotal, currency)}</Body>
        </View>
      )}

      {archiveFee > 0 ? (
        <View style={styles.summaryRow}>
          <View>
            <Body muted>Archívny poplatok</Body>
            <Caption>
              {quantity} × {formatMoney(archiveFee / quantity, currency)} za vstupenku
            </Caption>
          </View>
          <Body muted>{formatMoney(archiveFee, currency)}</Body>
        </View>
      ) : null}

      <View style={styles.summaryRow}>
        <Text style={styles.total}>Spolu</Text>
        <Text style={styles.total}>{formatMoney(payable, currency)}</Text>
      </View>

      {vatLabel && payable > 0 ? (
        <View style={styles.summaryRow}>
          <Caption>({vatLabel})</Caption>
        </View>
      ) : null}
    </>
  );

  return (
    <Screen scroll>
      <Text style={styles.eventTitle}>{event.data.title}</Text>
      <Caption>{event.data.venue_name ?? event.data.address ?? ''}</Caption>

      {/* Ukazovateľ postupu. Nie ozdoba: bez neho človek pri prvom kroku
          nevie, či ho čaká ešte jedna otázka alebo osem. */}
      <View style={styles.steps}>
        {steps.map((entry, index) => {
          const done = index < stepIndex;
          const here = index === stepIndex;
          return (
            <View key={entry.key} style={styles.stepItem}>
              <View style={[
                styles.stepDot,
                done && styles.stepDotDone,
                here && styles.stepDotHere,
              ]}>
                <Text style={[styles.stepNumber, (done || here) && styles.stepNumberOn]}>
                  {done ? '✓' : index + 1}
                </Text>
              </View>
              <Text style={[styles.stepLabel, here && styles.stepLabelHere]} numberOfLines={1}>
                {entry.label}
              </Text>
              {index < steps.length - 1 ? (
                <View style={[styles.stepLine, done && styles.stepLineDone]} />
              ) : null}
            </View>
          );
        })}
      </View>

      {error ? <Notice tone="danger" title="Problém s platbou" body={error} /> : null}

      {!canTakePayment() ? (
        <Notice
          tone="warning"
          title="Platby kartou potrebujú development build"
          body={unavailableMessage}
        />
      ) : requiresPublishableKey && !isConfigured.stripe ? (
        <Notice
          tone="warning"
          title="Platby nie sú nakonfigurované"
          body="Tento build nemá Stripe publishable key, takže platobný formulár sa nedá otvoriť. Doplň EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY a serverové kľúče — pozri PAYMENTS.md."
        />
      ) : null}

      {/* ---------- 1. Vstupenka ------------------------------------------ */}
      {step === 'ticket' ? (
        <>
          <SectionHeader title="Vyber si vstupenku" />
          {ticketTypes.map((type) => {
            const remaining = type.quantity_total - type.quantity_sold;
            const soldOut = remaining <= 0;
            const isSelected = selected?.id === type.id;

            return (
              <Pressable
                key={type.id}
                onPress={() => {
                  if (soldOut) return;
                  setTicketTypeId(type.id);
                  setQuantity(1);
                }}
                style={[styles.option, isSelected && styles.optionSelected, soldOut && styles.optionDisabled]}
              >
                <View style={styles.flex}>
                  <Text style={styles.optionName}>{type.name}</Text>
                  {type.description ? <Caption>{type.description}</Caption> : null}
                  <Caption style={soldOut ? styles.soldOut : undefined}>
                    {soldOut ? 'Vypredané' : `${remaining} k dispozícii`}
                  </Caption>
                </View>
                <Text style={styles.optionPrice}>{formatPrice(type.price_cents, type.currency)}</Text>
              </Pressable>
            );
          })}

          <SectionHeader title="Koľko kusov" />
          <View style={styles.quantityRow}>
            <Button
              title="−"
              variant="secondary"
              compact
              onPress={() => setQuantity((value) => Math.max(1, value - 1))}
              disabled={quantity <= 1}
            />
            <Text style={styles.quantity}>{quantity}</Text>
            <Button
              title="+"
              variant="secondary"
              compact
              onPress={() => setQuantity((value) => Math.min(maxQuantity, value + 1))}
              disabled={quantity >= maxQuantity}
            />
            <Caption style={styles.quantityHint}>Max {maxQuantity} na objednávku</Caption>
          </View>

          <Divider />
          {summary}

          {/* Zľavový kód za odkazom, nie ako pole navrchu. Prázdne políčko
              „Promo kód" pýta od väčšiny ľudí niečo, čo nemajú, a tých
              ostatných pošle hľadať kód inam uprostred nákupu. */}
          {promoOpen ? (
            <>
              <View style={styles.promoRow}>
                <Input
                  value={promoCode}
                  onChangeText={(value) => {
                    setPromoCode(value.toUpperCase());
                    setPromo(null);
                  }}
                  placeholder="Napr. BLUP20"
                  autoCapitalize="characters"
                  autoCorrect={false}
                  style={styles.promoInput}
                />
                <Button
                  title="Použiť"
                  variant="secondary"
                  compact
                  inRow
                  loading={checkingPromo}
                  disabled={!promoCode.trim()}
                  onPress={applyPromo}
                />
              </View>

              {promo ? (
                promo.valid ? (
                  <Notice
                    tone="success"
                    title={`Zľava ${formatMoney(promo.amount_off, currency)}`}
                    body="Zľavu prepočíta server pri vytvorení objednávky — to, čo vidíš, je to, čo zaplatíš."
                  />
                ) : (
                  <Notice tone="warning" title="Kód neplatí" body={promoReason(promo.reason)} />
                )
              ) : null}
            </>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() => setPromoOpen(true)}
              style={styles.promoLink}
            >
              <Text style={styles.promoLinkLabel}>Máš zľavový kód?</Text>
            </Pressable>
          )}

          <Caption style={styles.feeNote}>
            {archiveFee > 0
              ? 'Archívny poplatok pokrýva vydanie a uchovanie vstupenky. Provízia BLUPu sa strháva z výplaty organizátora — k tvojej cene sa nepripočítava.'
              : 'Provízia BLUPu sa strháva z výplaty organizátora, nepripočítava sa k tvojej cene.'}
          </Caption>

          <Button
            title="Pokračovať"
            onPress={() => {
              setError(null);
              setStep(needsDetails ? 'details' : 'pay');
            }}
            disabled={!selected || paymentsBlocked}
            full
            style={styles.stepButton}
          />
        </>
      ) : null}

      {/* ---------- 2. Údaje (iba nákup bez účtu) -------------------------- */}
      {step === 'details' ? (
        <>
          <SectionHeader title="Kam ti máme poslať vstupenku" />
          <Caption style={styles.guestIntro}>
            Účet na to nepotrebuješ. QR kód ti príde e-mailom a funguje pri vstupe tak ako
            každý iný. Ak si účet neskôr založíš na tú istú adresu, vstupenka sa v ňom objaví.
          </Caption>

          <Input
            label="Meno a priezvisko"
            value={guestName}
            onChangeText={setGuestName}
            placeholder="Jana Nováková"
            autoComplete="name"
            hint="Toto meno bude na vstupenke."
          />
          <Input
            label="E-mail"
            value={guestEmail}
            onChangeText={setGuestEmail}
            placeholder="jana@example.com"
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            hint="Sem príde vstupenka. Skontroluj si preklep — inam ju poslať nevieme."
          />
          <Input
            label="Mesto, odkiaľ prídeš"
            value={guestCity}
            onChangeText={setGuestCity}
            placeholder="Nitra"
            hint="Organizátor podľa toho vie, odkiaľ mu ľudia chodia. Adresu nechceme."
          />

          <Button
            title="Pokračovať na platbu"
            onPress={() => { setError(null); setStep('pay'); }}
            disabled={!guestReady}
            full
            style={styles.stepButton}
          />
          <Button
            title="Mám účet, prihlásim sa"
            variant="ghost"
            onPress={() => router.push('/(auth)/sign-in')}
          />
          <Button title="Späť" variant="ghost" onPress={goBack} />
        </>
      ) : null}

      {/* ---------- 3. Platba --------------------------------------------- */}
      {step === 'pay' ? (
        <>
          <SectionHeader title="Zaplatiť" />

          <View style={styles.recap}>
            <View style={styles.summaryRow}>
              <Body muted>{quantity} × {selected?.name ?? 'Vstupenka'}</Body>
              <Body>{formatMoney(payable, currency)}</Body>
            </View>
            {needsDetails ? (
              <Caption>Vstupenka príde na {guestEmail.trim()}</Caption>
            ) : null}
          </View>

          {payable === 0 ? (
            <Button
              title="Získať vstupenku"
              onPress={pay}
              loading={stage === 'paying'}
              disabled={!selected}
              full
              style={styles.stepButton}
            />
          ) : inlineReady ? (
            <PaymentForm
              amountCents={payable}
              currency={currency}
              payLabel={`Zaplatiť ${formatMoney(payable, currency)}`}
              disabled={!selected || (needsDetails && !guestReady)}
              createIntent={createInlineIntent}
              onAuthorized={onAuthorized}
              onError={setError}
            />
          ) : (
            <Button
              title={`Zaplatiť ${formatMoney(payable, currency)}`}
              onPress={pay}
              loading={stage === 'paying'}
              disabled={!selected || paymentsBlocked || (needsDetails && !guestReady)}
              full
              style={styles.stepButton}
            />
          )}

          <Button title="Späť" variant="ghost" onPress={goBack} />
        </>
      ) : null}

      {orderId ? (
        <Caption style={styles.orderRef}>Objednávka {orderId.slice(0, 8)}</Caption>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
  eventTitle: { ...typography.heading, color: colors.text },

  steps: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
    marginBottom: spacing.md,
  },
  stepItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  stepDot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  stepDotHere: { backgroundColor: colors.accent, borderColor: colors.accent },
  stepDotDone: { backgroundColor: colors.surfaceElevated2, borderColor: colors.accent },
  stepNumber: { ...typography.captionStrong, color: colors.textSecondary },
  stepNumberOn: { color: colors.text },
  stepLabel: { ...typography.caption, color: colors.textSecondary },
  stepLabelHere: { color: colors.text },
  // Čiara medzi krokmi. `flexShrink` a nie pevná šírka, aby sa ukazovateľ
  // zmestil aj na úzky telefón a nevytlačil poslednú nálepku mimo obrazovky.
  stepLine: {
    width: 24,
    flexShrink: 1,
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: spacing.xs,
  },
  stepLineDone: { backgroundColor: colors.accent },

  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  optionSelected: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  optionDisabled: { opacity: 0.5 },
  optionName: { ...typography.bodyStrong, color: colors.text },
  optionPrice: { ...typography.subheading, color: colors.text },
  soldOut: { color: colors.danger },

  quantityRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  quantity: { ...typography.heading, color: colors.text, minWidth: 30, textAlign: 'center' },
  promoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  promoLink: { paddingVertical: spacing.md },
  promoLinkLabel: { ...typography.captionStrong, color: colors.accentText },
  discountLabel: { color: colors.success },
  discountValue: { color: colors.success },
  promoInput: { flex: 1, marginBottom: 0 },
  guestIntro: { marginBottom: spacing.md },
  quantityHint: { marginLeft: 'auto' },

  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  recap: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  total: { ...typography.subheading, color: colors.text },
  feeNote: { marginTop: spacing.sm },
  stepButton: { marginTop: spacing.lg },
  orderRef: { textAlign: 'center', marginTop: spacing.md },

  success: { alignItems: 'center', gap: spacing.md, paddingTop: spacing.xxxl },
  successEmoji: { fontSize: 56 },
  successTitle: { ...typography.title, color: colors.text },
  successBody: { textAlign: 'center', marginBottom: spacing.lg },

  confirmHint: { textAlign: 'center', paddingHorizontal: spacing.xl, marginBottom: spacing.xxl },
});
