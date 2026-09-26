import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  confirmResaleTicket, getMyResaleOrders, openResaleDispute,
  type DisputeReason, type ResaleOrder,
} from '@/api/resale';
import { signedResaleTicketUrl } from '@/storage/uploads';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';
import { AuthenticityBadge } from '@/components/AuthenticityBadge';
import { useDialog } from '@/components/Dialog';
import { Button, Caption, Notice, SectionHeader } from '@/components/ui';
import { SWAP_BRAND } from '@/swap/brand';
import { messageFor } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import { CONTENT_MAX } from '@/hooks/useLayout';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Objednávky z burzy medzi mojimi vstupenkami.
 *
 * Patria sem a nie na vlastnú obrazovku: človek, ktorý kúpil vstupenku, ju
 * hľadá tam, kde má ostatné. Schovať ju do „burzy" by znamenalo, že si na
 * evente otvorí prázdne „moje vstupenky" a bude myslieť, že sa nákup nepodaril.
 *
 * Dve tlačidlá, ktoré tu musia byť, lebo bez nich nefunguje ochrana peňazí:
 *
 *   „Vstupenka funguje"  toto uvoľňuje peniaze predajcovi. Kým to kupujúci
 *                        nestlačí, predajca externej vstupenky nedostane nič —
 *                        a to je jediné, čím vieme pravosť nahradiť.
 *
 *   „Nahlásiť problém"   otvorí spor, zadrží peniaze a pustí to k podpore.
 *                        Bez neho je „vrátime ti peniaze" veta bez cesty.
 */
const REASONS: { key: DisputeReason; label: string; body: string }[] = [
  { key: 'not_received',    label: 'Nedorazila',        body: 'Predajca mi vstupenku neposlal.' },
  { key: 'invalid',         label: 'Nefunguje',         body: 'Neprešla pri vstupe alebo je neplatná.' },
  { key: 'not_as_described',label: 'Je iná, než bola',  body: 'Iné miesto, iný sektor alebo iný deň.' },
  { key: 'other',           label: 'Niečo iné',         body: 'Napíšem, čo sa stalo.' },
];

export function MySwapOrders() {
  const { isGuest } = useAuth();
  const queryClient = useQueryClient();
  const dialog = useDialog();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Pri ktorej objednávke je práve otvorený výber dôvodu. */
  const [picking, setPicking] = useState<string | null>(null);

  const orders = useQuery({
    queryKey: ['resale', 'orders', 'mine'],
    queryFn: getMyResaleOrders,
    enabled: !isGuest,
  });

  const { profile } = useAuth();
  // Tabuľka vracia aj to, čo predávam. Tu patrí len to, čo som kúpil —
  // predané mám v prehľade predajcu a dvakrát to isté je len dlhšia obrazovka.
  const bought = (orders.data ?? []).filter(
    (order) => order.buyer_id === profile?.id && order.payment_status === 'succeeded',
  );

  if (bought.length === 0) return null;

  const confirm = async (order: ResaleOrder) => {
    setError(null);
    try {
      await dialog.confirm({
        title: 'Vstupenka funguje?',
        body: 'Potvrdením sa peniaze uvoľnia predajcovi. Potvrdzuj až vtedy, '
          + 'keď vstupenku naozaj máš a je platná.',
        confirmLabel: 'Áno, funguje',
      });
    } catch {
      return;
    }
    setBusy(order.id);
    try {
      await confirmResaleTicket(order.id);
      await queryClient.invalidateQueries({ queryKey: ['resale'] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Nahlásenie problému.
   *
   * Dôvod sa vyberá priamo v karte a nie v dialógu: dialóg v tomto projekte
   * vie potvrdiť a opýtať sa na text, nie ponúknuť zoznam — a vyrobiť tretí
   * druh dialógu kvôli jednej obrazovke by znamenalo tretiu vec, ktorá sa
   * musí správať rovnako na telefóne aj v prehliadači.
   */
  const report = async (order: ResaleOrder, reason: DisputeReason) => {
    setError(null);
    setPicking(null);
    setBusy(order.id);
    try {
      await openResaleDispute(order.id, reason);
      await queryClient.invalidateQueries({ queryKey: ['resale'] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.wrap}>
      <SectionHeader title={SWAP_BRAND} />
      {error ? <Notice tone="danger" title="Nepodarilo sa" body={error} /> : null}
      {bought.map((order) => (
        <OrderCard
          key={order.id}
          order={order}
          busy={busy === order.id}
          picking={picking === order.id}
          onConfirm={() => void confirm(order)}
          onReport={() => setPicking(picking === order.id ? null : order.id)}
          onReason={(reason) => void report(order, reason)}
        />
      ))}
    </View>
  );
}

function OrderCard({
  order, busy, picking, onConfirm, onReport, onReason,
}: {
  order: ResaleOrder;
  busy: boolean;
  picking: boolean;
  onConfirm: () => void;
  onReport: () => void;
  onReason: (reason: DisputeReason) => void;
}) {
  const event = useQuery({
    queryKey: ['resale', 'order-event', order.event_id],
    queryFn: async () => {
      const { data } = await supabase
        .from('events').select('title, start_at, venue_name').eq('id', order.event_id).single();
      return data as { title: string; start_at: string; venue_name: string | null } | null;
    },
    staleTime: 300_000,
  });

  const [state, tone] = stateOf(order);

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.title} numberOfLines={1}>
            {event.data?.title ?? 'Event'}
          </Text>
          {event.data?.venue_name ? <Caption>{event.data.venue_name}</Caption> : null}
        </View>
        <AuthenticityBadge
          authenticity={order.source === 'blup' ? 'verified' : 'protected'}
          size="s"
        />
      </View>

      <View style={styles.stateRow}>
        <View style={[styles.pill, tone === 'good' && styles.pillGood,
                      tone === 'warn' && styles.pillWarn]}>
          <Text style={[styles.pillLabel, tone === 'good' && styles.pillLabelGood,
                        tone === 'warn' && styles.pillLabelWarn]}>
            {state}
          </Text>
        </View>
        <Caption style={styles.paid}>
          zaplatené {formatMoney(order.total_cents, order.currency)}
        </Caption>
      </View>

      {/* Naša vstupenka je už medzi ostatnými — prevod prebehol pri platbe. */}
      {order.source === 'blup' && order.order_status !== 'disputed' ? (
        <Caption style={styles.note}>
          Vstupenka je prepísaná na teba a nájdeš ju vyššie medzi ostatnými.
        </Caption>
      ) : null}

      {order.order_status === 'waiting_for_ticket' ? (
        <Caption style={styles.note}>
          Predajca ju ešte neposlal. Peniaze držíme — ak nedorazí, vrátime ti ich.
        </Caption>
      ) : null}

      {order.source === 'external' && order.order_status === 'ticket_delivered' ? (
        <TicketFile orderId={order.id} />
      ) : null}

      {order.order_status === 'disputed' ? (
        <Notice
          tone="warning"
          title="Riešime to"
          body="Peniaze sú zadržané. Ozveme sa ti s postupom."
        />
      ) : null}

      {/* Potvrdiť sa dá len to, čo naozaj dorazilo. Ponúkať to skôr by
          znamenalo pýtať si potvrdenie o niečom, čo človek ešte nevidel. */}
      {order.order_status === 'ticket_delivered' ? (
        <View style={styles.actions}>
          <Button
            title={busy ? 'Moment…' : 'Vstupenka funguje'}
            onPress={onConfirm}
            disabled={busy}
            style={styles.action}
          />
          <Pressable onPress={onReport} disabled={busy} hitSlop={8}>
            <Text style={styles.report}>Nahlásiť problém</Text>
          </Pressable>
        </View>
      ) : null}

      {order.order_status === 'waiting_for_ticket' ? (
        <Pressable onPress={onReport} disabled={busy} hitSlop={8} style={styles.reportAlone}>
          <Text style={styles.report}>Nedorazila? Nahlás to</Text>
        </Pressable>
      ) : null}

      {picking ? (
        <View style={styles.reasons}>
          <Caption style={styles.reasonsTitle}>
            Čo sa stalo? Peniaze zadržíme, kým to nevyriešime.
          </Caption>
          {REASONS.map((reason) => (
            <Pressable
              key={reason.key}
              onPress={() => onReason(reason.key)}
              disabled={busy}
              style={styles.reason}
              accessibilityRole="button"
            >
              <Text style={styles.reasonLabel}>{reason.label}</Text>
              <Caption>{reason.body}</Caption>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Súbor, ktorý predajca poslal.
 *
 * Adresa sa pýta až pri kliknutí a platí pár minút. Vstupenka je cenina:
 * adresa, ktorá by platila navždy, je to isté ako verejný súbor, len s dlhším
 * menom.
 */
function TicketFile({ orderId }: { orderId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const delivery = useQuery({
    queryKey: ['resale', 'delivery', orderId],
    queryFn: async () => {
      const { data } = await supabase
        .from('resale_deliveries')
        .select('file_path, transfer_note')
        .eq('resale_order_id', orderId)
        .order('delivered_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data as { file_path: string | null; transfer_note: string | null } | null;
    },
  });

  const row = delivery.data;
  if (!row) return null;

  const open = async () => {
    if (!row.file_path) return;
    setBusy(true);
    setError(null);
    try {
      const url = await signedResaleTicketUrl(row.file_path);
      if (typeof globalThis !== 'undefined' && 'open' in globalThis) {
        (globalThis as { open?: (u: string) => void }).open?.(url);
      } else {
        router.push(url as never);
      }
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.delivery}>
      {row.transfer_note ? <Caption>{row.transfer_note}</Caption> : null}
      {error ? <Caption style={styles.error}>{error}</Caption> : null}
      {row.file_path ? (
        <Button
          title={busy ? 'Otváram…' : 'Otvoriť vstupenku'}
          variant="secondary"
          onPress={() => void open()}
          disabled={busy}
        />
      ) : null}
    </View>
  );
}

function stateOf(order: ResaleOrder): [string, 'plain' | 'good' | 'warn'] {
  switch (order.order_status) {
    case 'waiting_for_ticket': return ['Čaká na predajcu', 'warn'];
    case 'ticket_delivered':   return ['Dorazila — potvrď ju', 'warn'];
    case 'completed':          return ['Hotovo', 'good'];
    case 'disputed':           return ['Riešime problém', 'warn'];
    case 'refunded':           return ['Vrátené', 'plain'];
    case 'cancelled':          return ['Zrušené', 'plain'];
    default:                   return ['Zaplatené', 'good'];
  }
}

const styles = StyleSheet.create({
  wrap: { maxWidth: CONTENT_MAX, width: '100%', alignSelf: 'center' },
  card: {
    padding: spacing.md,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  headText: { flex: 1 },
  title: { ...typography.bodyStrong, color: colors.text },

  stateRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  paid: { flex: 1 },
  pill: {
    paddingHorizontal: spacing.sm, paddingVertical: 3,
    borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border,
  },
  pillGood: { backgroundColor: colors.successSoft, borderColor: colors.success },
  pillWarn: { backgroundColor: colors.warningSoft, borderColor: colors.warning },
  pillLabel: { ...typography.metaSm, color: colors.textSecondary },
  pillLabelGood: { color: colors.success },
  pillLabelWarn: { color: colors.warning },

  note: { lineHeight: 18 },
  delivery: { gap: spacing.xs, marginTop: spacing.xs },
  error: { color: colors.danger },

  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.xs },
  action: { flex: 1 },
  report: { ...typography.metaSm, color: colors.textSecondary, textDecorationLine: 'underline' },
  reportAlone: { marginTop: spacing.xs, alignSelf: 'flex-start' },

  reasons: {
    marginTop: spacing.sm,
    gap: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  reasonsTitle: { marginBottom: 2 },
  reason: {
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
  },
  reasonLabel: { ...typography.bodyStrong, color: colors.text },
});
