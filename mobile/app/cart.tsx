import React, { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import {
  clearCart, getCart, removeFromCart, setCartQuantity, type CartLine,
} from '@/api/cart';
import { getEventVatInfo } from '@/api/events';
import { payForCart } from '@/payments/checkout';
import { track } from '@/marketing/tags';
import { messageFor } from '@/lib/errors';
import { formatMoney, vatIncludedLabel } from '@/lib/format';
import { SignInInvite } from '@/components/SignInInvite';
import { useLayout } from '@/hooks/useLayout';
import {
  Button, Caption, Divider, EmptyState, Input, LoadingState, Mono, Notice, Screen,
  SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Košík.
 *
 * The reservation is real: the tickets in here are held against everybody else
 * for 15 minutes, and the counter is the truth rather than decoration. When it
 * runs out the lines go back into the pool — so the screen says so and refetches
 * instead of leaving a basket on screen that no longer holds anything.
 *
 * Nothing here decides a price. Every number comes from `cart_view()`, which is
 * the same arithmetic the order will use, so the total on this page is the
 * total on the card statement.
 */
export default function CartScreen() {
  const { isGuest } = useAuth();
  const layout = useLayout();
  const queryClient = useQueryClient();

  const [promoInput, setPromoInput] = useState('');
  const [promo, setPromo] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const cart = useQuery({
    queryKey: ['cart', promo],
    queryFn: () => getCart(promo),
    enabled: !isGuest,
    refetchOnWindowFocus: true,
  });

  const data = cart.data;
  const expiresAt = data?.expires_at ?? null;
  const refetch = cart.refetch;

  // One clock for the whole basket, driven by the server's expiry rather than
  // by a countdown the client starts and could quietly get wrong.
  useEffect(() => {
    if (!expiresAt) {
      setSecondsLeft(0);
      return;
    }

    const deadline = new Date(expiresAt).getTime();
    const tick = () => setSecondsLeft(Math.max(0, Math.round((deadline - Date.now()) / 1000)));

    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  useEffect(() => {
    if (secondsLeft !== 0 || !expiresAt) return;
    void refetch();
  }, [secondsLeft, expiresAt, refetch]);

  const apply = useCallback(
    async (ticketTypeId: string, next: number) => {
      setError(null);
      setBusy(ticketTypeId);
      try {
        const updated = next < 1
          ? await removeFromCart(ticketTypeId)
          : await setCartQuantity(ticketTypeId, next);
        queryClient.setQueryData(['cart', promo], updated);
      } catch (caught) {
        setError(messageFor(caught));
        void refetch();
      } finally {
        setBusy(null);
      }
    },
    [promo, queryClient, refetch],
  );

  const pay = useCallback(async () => {
    setError(null);
    setPaying(true);
    try {
      track('begin_checkout', {
        valueCents: data?.total_cents ?? 0,
        currency: data?.currency,
        contentName: data?.event?.title,
        items: (data?.lines ?? []).map((line) => ({
          id: line.ticket_type_id, name: line.name, quantity: line.quantity,
        })),
      });

      const result = await payForCart(promo);
      // 'redirecting' navigates away on its own; a free basket is already paid.
      if (result.status === 'succeeded') router.replace('/tickets');
    } catch (caught) {
      setError(messageFor(caught));
      void refetch();
    } finally {
      setPaying(false);
    }
  }, [promo, refetch]);

  if (isGuest) {
    return (
      <Screen>
        <SignInInvite
          title="Košík patrí k účtu"
          body="Rezervácia drží vstupenky 15 minút — a musí vedieť, komu ich drží."
        />
      </Screen>
    );
  }

  if (cart.isLoading) return <Screen><LoadingState label="Otváram košík…" /></Screen>;

  const lines = data?.lines ?? [];
  const expired = Boolean(expiresAt) && secondsLeft <= 0;

  if (lines.length === 0 || expired) {
    return (
      <Screen scroll>
        {expired ? (
          <Notice
            tone="warning"
            title="Rezervácia vypršala"
            body="Vstupenky sa vrátili do predaja. Ak sú stále voľné, pridaj si ich znova."
          />
        ) : null}
        <EmptyState
          emoji="🎟"
          title="Košík je prázdny"
          body="Vyber si event a pridaj vstupenky. Držíme ti ich 15 minút."
          actionLabel="Nájsť event"
          onAction={() => router.replace('/')}
        />
      </Screen>
    );
  }

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  const urgent = secondsLeft > 0 && secondsLeft <= 120;

  // Buyers pay one number. This only says VAT is already inside it, and only
  // when the organizer behind this basket is registered for VAT.
  const vat = useQuery({
    queryKey: ['event', data?.event?.id, 'vat'],
    queryFn: () => getEventVatInfo(data!.event!.id),
    enabled: Boolean(data?.event?.id),
    staleTime: 10 * 60_000,
  });
  const vatLabel = vatIncludedLabel(vat.data?.isVatPayer, vat.data?.rateBps);

  // On a desktop the basket is a two-column page: what you are buying on the
  // left, what it costs and the button on the right, where it stays in view
  // instead of sitting a scroll below the last ticket type.
  const summary = (
    <View style={layout.isWide ? styles.aside : undefined}>
      <View style={styles.summary}>
        <Row
          label={`Vstupenky (${data?.quantity ?? 0})`}
          value={formatMoney(data?.subtotal_cents ?? 0, data?.currency)}
        />
        {(data?.discount_cents ?? 0) > 0 ? (
          <Row label="Zľava" value={`− ${formatMoney(data!.discount_cents, data?.currency)}`} />
        ) : null}
        {(data?.archive_fee_cents ?? 0) > 0 ? (
          <Row
            label={`Archívny poplatok (${data?.quantity ?? 0}×)`}
            value={formatMoney(data!.archive_fee_cents, data?.currency)}
          />
        ) : null}
        <Divider />
        <Row label="Spolu" value={formatMoney(data?.total_cents ?? 0, data?.currency)} strong />
        {vatLabel ? (
          <Row label={`(${vatLabel})`} value="" muted />
        ) : null}
      </View>

      <Caption style={styles.note}>
        Archívny poplatok pokrýva uchovanie vstupenky a jej overenie pri vstupe. Provízia BLUP sa
        strháva organizátorovi — teba sa netýka.
      </Caption>

      <Button
        title={`Zaplatiť ${formatMoney(data?.total_cents ?? 0, data?.currency)}`}
        onPress={() => void pay()}
        loading={paying}
        large
        full
      />

      <Button
        title="Vyprázdniť"
        variant="ghost"
        onPress={async () => {
          try {
            queryClient.setQueryData(['cart', promo], await clearCart());
          } catch (caught) {
            setError(messageFor(caught));
          }
        }}
      />

      {Platform.OS === 'web' ? (
        <Caption style={styles.note}>
          Platbu spracúva Stripe. Číslo karty sa na BLUP nikdy nedostane.
        </Caption>
      ) : null}
    </View>
  );

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Toto sa nepodarilo" body={error} /> : null}

      {/* --- the clock ----------------------------------------------------- */}
      <View style={[styles.clock, urgent && styles.clockUrgent]}>
        <Text style={[styles.clockValue, urgent && styles.clockValueUrgent]}>
          {minutes}:{String(seconds).padStart(2, '0')}
        </Text>
        <View style={styles.flex}>
          <Text style={styles.clockTitle}>Vstupenky sú rezervované</Text>
          <Caption>Po vypršaní sa vrátia do predaja. Zmena v košíku rezerváciu obnoví.</Caption>
        </View>
      </View>

      <View style={layout.isWide ? styles.columns : undefined}>
        <View style={layout.isWide ? styles.main : undefined}>

      {data?.event ? (
        <>
          <SectionHeader title={data.event.title} />
          <Caption>{data.event.venue_name ?? data.event.city ?? ''}</Caption>
        </>
      ) : null}

      {/* --- lines --------------------------------------------------------- */}
      <View style={styles.lines}>
        {lines.map((line) => (
          <Line
            key={line.ticket_type_id}
            line={line}
            busy={busy === line.ticket_type_id}
            basketQuantity={data?.quantity ?? 0}
            cap={data?.limits.max_tickets_per_order ?? 20}
            onChange={(next) => void apply(line.ticket_type_id, next)}
          />
        ))}
      </View>

      <Caption style={styles.note}>
        Na jednu objednávku ide najviac {data?.limits.max_tickets_per_order ?? 20} vstupeniek.
      </Caption>

      {/* --- promo --------------------------------------------------------- */}
      <SectionHeader title="Zľavový kód" />
      <View style={styles.promoRow}>
        <View style={styles.flex}>
          <Input
            label=""
            value={promoInput}
            onChangeText={setPromoInput}
            placeholder="napr. EARLY20"
            autoCapitalize="characters"
            returnKeyType="done"
            onSubmitEditing={() => setPromo(promoInput.trim() || null)}
          />
        </View>
        <Button
          title={promo ? 'Zrušiť' : 'Použiť'}
          variant="secondary"
          compact
          onPress={() => {
            if (promo) {
              setPromo(null);
              setPromoInput('');
            } else {
              setPromo(promoInput.trim() || null);
            }
          }}
        />
      </View>
      {data?.promo_error ? (
        <Caption style={styles.promoError}>Kód sa nedal použiť.</Caption>
      ) : null}

        </View>

        {summary}
      </View>
    </Screen>
  );
}

function Line({
  line, busy, basketQuantity, cap, onChange,
}: {
  line: CartLine;
  busy: boolean;
  basketQuantity: number;
  cap: number;
  onChange: (next: number) => void;
}) {
  // Three ceilings, and the lowest wins: what this ticket type allows per order,
  // what is physically left, and what fits under the 20-per-order cap.
  const roomInBasket = cap - basketQuantity + line.quantity;
  const ceiling = Math.min(line.max_per_order, line.available + line.quantity, roomInBasket);

  return (
    <View style={styles.line}>
      <View style={styles.flex}>
        <Text style={styles.lineName}>{line.name}</Text>
        <Caption>{formatMoney(line.unit_price_cents, line.currency)} / ks</Caption>
        {line.available === 0 ? (
          <Caption style={styles.last}>Toto sú posledné voľné</Caption>
        ) : null}
      </View>

      <View style={styles.stepper}>
        <Step glyph="−" disabled={busy} onPress={() => onChange(line.quantity - 1)} />
        <Mono style={styles.count}>{String(line.quantity)}</Mono>
        <Step
          glyph="+"
          disabled={busy || line.quantity >= ceiling}
          onPress={() => onChange(line.quantity + 1)}
        />
      </View>

      <Text style={styles.lineTotal}>{formatMoney(line.line_total_cents, line.currency)}</Text>
    </View>
  );
}

function Step({
  glyph, disabled, onPress,
}: { glyph: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.step, disabled && styles.stepOff, pressed && styles.stepDown]}
    >
      <Text style={[styles.stepGlyph, disabled && styles.stepGlyphOff]}>{glyph}</Text>
    </Pressable>
  );
}

function Row({
  label, value, strong, muted,
}: {
  label: string;
  value: string;
  strong?: boolean;
  /** A note under the total — "(s DPH 23 %)" — not a line of its own arithmetic. */
  muted?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text
        style={[styles.rowLabel, strong && styles.rowLabelStrong, muted && styles.rowMuted]}
      >
        {label}
      </Text>
      <Text
        style={[styles.rowValue, strong && styles.rowValueStrong, muted && styles.rowMuted]}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },

  rowMuted: { color: colors.textTertiary, ...typography.caption },

  columns: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xxl },
  main: { flex: 1, minWidth: 0 },
  aside: {
    width: 320,
    gap: spacing.sm,
    // Sticky rather than fixed: it scrolls with short baskets and pins itself
    // once the list of ticket types is longer than the window.
    ...(Platform.OS === 'web' ? ({ position: 'sticky', top: spacing.xxl } as object) : null),
  },

  clock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.card,
    backgroundColor: colors.accentSoft,
  },
  clockUrgent: { backgroundColor: colors.dangerSoft },
  clockValue: { ...typography.title, color: colors.accent, fontVariant: ['tabular-nums'] },
  clockValueUrgent: { color: colors.danger },
  clockTitle: { ...typography.bodyStrong, color: colors.text },

  lines: { gap: spacing.sm },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  lineName: { ...typography.rowTitle, color: colors.text },
  lineTotal: { ...typography.bodyStrong, color: colors.text, minWidth: 78, textAlign: 'right' },
  last: { color: colors.danger },

  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  step: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceElevated,
  },
  stepOff: { opacity: 0.4 },
  stepDown: { opacity: 0.7 },
  stepGlyph: { ...typography.subheading, color: colors.text },
  stepGlyphOff: { color: colors.textMuted },
  count: { minWidth: 22, textAlign: 'center', color: colors.text },

  promoRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.md },
  promoError: { color: colors.danger },

  summary: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    padding: spacing.lg,
    marginTop: spacing.lg,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  rowLabel: { ...typography.body, color: colors.textSecondary },
  rowLabelStrong: { ...typography.subheading, color: colors.text },
  rowValue: { ...typography.body, color: colors.textSecondary },
  rowValueStrong: { ...typography.subheading, color: colors.text },

  note: { marginTop: spacing.md },
});
