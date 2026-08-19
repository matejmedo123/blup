import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';


import { getEvent } from '@/api/events';
import {
  createCheckout, markTicketPurchaseSignal, previewPromoCode, quoteOrder, waitForTickets,
  type PromoPreview,
} from '@/api/tickets';
import { isConfigured } from '@/lib/env';
import { isStripeModuleAvailable, STRIPE_UNAVAILABLE_MESSAGE, useStripeBridge } from '@/payments/stripe';
import { messageFor } from '@/lib/errors';
import { formatMoney, formatPrice } from '@/lib/format';
import {
  Body, Button, Caption, Divider, ErrorState, Input, LoadingState, Mono, Notice, Screen,
  SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

type Stage = 'select' | 'paying' | 'confirming' | 'done';

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
 * Checkout.
 *
 * The client never decides what anything costs and never marks an order paid:
 *   1. checkout-create computes the amounts and returns a PaymentIntent secret
 *   2. Stripe's PaymentSheet takes the card / Apple Pay / Google Pay
 *   3. the webhook confirms the money and issues the tickets
 *   4. this screen waits for those tickets to appear
 */
export default function CheckoutScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { initPaymentSheet, presentPaymentSheet } = useStripeBridge();

  const [ticketTypeId, setTicketTypeId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [stage, setStage] = useState<Stage>('select');
  const [error, setError] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [promoCode, setPromoCode] = useState('');
  const [promo, setPromo] = useState<PromoPreview | null>(null);
  const [checkingPromo, setCheckingPromo] = useState(false);

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

  const pay = async () => {
    if (!selected) return;

    setError(null);
    setStage('paying');

    try {
      // 1. server computes amounts + creates the order
      const session = await createCheckout(selected.id, quantity, promo?.valid ? promoCode : null);
      setOrderId(session.order_id);

      // Free tickets skip the payment provider entirely.
      if (!session.requires_payment) {
        setStage('done');
        void markTicketPurchaseSignal(id!);
        return;
      }

      if (!session.payment_intent_client_secret) {
        throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');
      }

      // 2. native payment sheet (card, Apple Pay, Google Pay)
      const { error: initError } = await initPaymentSheet({
        merchantDisplayName: event.data?.organization?.name ?? 'BLUP',
        paymentIntentClientSecret: session.payment_intent_client_secret,
        applePay: { merchantCountryCode: 'SK' },
        googlePay: { merchantCountryCode: 'SK', testEnv: __DEV__ },
        returnURL: 'blup://stripe-redirect',
        allowsDelayedPaymentMethods: false,
      });

      if (initError) throw new Error(initError.message);

      const { error: sheetError } = await presentPaymentSheet();

      if (sheetError) {
        if (sheetError.code === 'Canceled') {
          setStage('select');
          return;
        }
        throw new Error(sheetError.message);
      }

      // 3. the webhook is the source of truth — wait for the ticket to exist
      setStage('confirming');
      const result = await waitForTickets(session.order_id);

      if (result.status === 'failed') {
        throw new Error('Platba neprešla. Nič sme ti nestrhli.');
      }

      void markTicketPurchaseSignal(id!);
      setStage('done');
    } catch (caught) {
      setError(messageFor(caught));
      setStage('select');
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

  return (
    <Screen scroll>
      <Text style={styles.eventTitle}>{event.data.title}</Text>
      <Caption>{event.data.venue_name ?? event.data.address ?? ''}</Caption>

      {error ? <Notice tone="danger" title="Problém s platbou" body={error} /> : null}

      {!isStripeModuleAvailable ? (
        <Notice
          tone="warning"
          title="Platby kartou potrebujú development build"
          body={STRIPE_UNAVAILABLE_MESSAGE}
        />
      ) : !isConfigured.stripe ? (
        <Notice
          tone="warning"
          title="Platby nie sú nakonfigurované"
          body="Tento build nemá Stripe publishable key, takže platobný formulár sa nedá otvoriť. Doplň EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY a serverové kľúče — pozri PAYMENTS.md."
        />
      ) : null}

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

      <View style={styles.summaryRow}>
        <Body muted>
          {quantity} × {selected ? formatPrice(selected.price_cents, selected.currency) : '—'}
        </Body>
        <Body>{formatMoney(subtotal, selected?.currency ?? 'EUR')}</Body>
      </View>

      <SectionHeader title="Promo kód" />
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
            editable={stage === 'select'}
            style={styles.promoInput}
          />
          <Button
            title="Použiť"
            variant="secondary"
            compact
            loading={checkingPromo}
            disabled={!promoCode.trim() || stage !== 'select'}
            onPress={applyPromo}
          />
        </View>

        {promo ? (
          promo.valid ? (
            <Notice
              tone="success"
              title={`Zľava ${formatMoney(promo.amount_off, selected?.currency ?? 'EUR')}`}
              body="Zľavu prepočíta server pri vytvorení objednávky — to, čo vidíš, je to, čo zaplatíš."
            />
          ) : (
            <Notice tone="warning" title="Kód neplatí" body={promoReason(promo.reason)} />
          )
        ) : null}

        <Divider />

        {discount > 0 ? (
          <>
            <View style={styles.summaryRow}>
              <Body muted>Medzisúčet</Body>
              <Body muted>{formatMoney(subtotal, selected?.currency ?? 'EUR')}</Body>
            </View>
            <View style={styles.summaryRow}>
              <Mono style={styles.discountLabel}>ZĽAVA {promoCode}</Mono>
              <Body style={styles.discountValue}>
                − {formatMoney(discount, selected?.currency ?? 'EUR')}
              </Body>
            </View>
          </>
        ) : null}

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

        <Caption style={styles.feeNote}>
          {archiveFee > 0
            ? 'Archívny poplatok pokrýva vydanie a uchovanie vstupenky. Provízia BLUPu sa strháva z výplaty organizátora — k tvojej cene sa nepripočítava.'
            : 'Provízia BLUPu sa strháva z výplaty organizátora, nepripočítava sa k tvojej cene.'}
        </Caption>

        <Button
          title={payable === 0 ? 'Získať vstupenku' : `Zaplatiť ${formatMoney(payable, currency)}`}
          onPress={pay}
          loading={stage === 'paying'}
          disabled={!selected || (payable > 0 && (!isConfigured.stripe || !isStripeModuleAvailable))}
          style={styles.payButton}
        />

        {orderId ? (
          <Caption style={styles.orderRef}>Objednávka {orderId.slice(0, 8)}</Caption>
        ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  eventTitle: { ...typography.heading, color: colors.text },

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
  discountLabel: { color: colors.success },
  discountValue: { color: colors.success },
  promoInput: { flex: 1, marginBottom: 0 },
  quantityHint: { marginLeft: 'auto' },

  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  total: { ...typography.subheading, color: colors.text },
  feeNote: { marginTop: spacing.sm },
  payButton: { marginTop: spacing.xl },
  orderRef: { textAlign: 'center', marginTop: spacing.md },

  success: { alignItems: 'center', gap: spacing.md, paddingTop: spacing.xxxl },
  successEmoji: { fontSize: 56 },
  successTitle: { ...typography.title, color: colors.text },
  successBody: { textAlign: 'center', marginBottom: spacing.lg },

  confirmHint: { textAlign: 'center', paddingHorizontal: spacing.xl, marginBottom: spacing.xxl },
});
