import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getSwapDisputes, getSwapHeldPayouts, getSwapOverview,
  releaseSellerPayout, resolveSwapDispute,
  type SwapDispute, type SwapHeldPayout, type SwapResolution,
} from '@/api/swapAdmin';
import { SWAP_BRAND } from '@/swap/brand';
import { useDialog } from '@/components/Dialog';
import {
  Button, Caption, LoadingState, Notice, Screen, SectionHeader, Title,
} from '@/components/ui';
import { messageFor } from '@/lib/errors';
import { formatMoney, formatRelative } from '@/lib/format';
import { CONTENT_MAX } from '@/hooks/useLayout';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Admin BLUP SWAPu — spory a zadržané výplaty.
 *
 * Obrazovka, na ktorej sa rozhoduje o cudzích peniazoch, musí mať podklady
 * hneď pri rozhodnutí. Zoznam „otvorený spor" s tlačidlom „vrátiť" je
 * rozhodovanie naslepo: nie je z neho vidieť, či vstupenka vôbec dorazila,
 * koľko človek zaplatil a či ten istý predajca nemá spor aj inde.
 *
 * Preto je pri každom spore všetko potrebné a pri každej zadržanej výplate
 * dôvod zadržania. „Uvoľniť" pri otvorenom spore si vyžiada poznámku —
 * peniaze, ktoré raz odídu, sa nemajú odkiaľ vrátiť.
 */
export default function SwapAdminScreen() {
  const queryClient = useQueryClient();
  const dialog = useDialog();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<'open' | 'resolved'>('open');

  const overview = useQuery({ queryKey: ['swap', 'admin'], queryFn: getSwapOverview });
  const disputes = useQuery({
    queryKey: ['swap', 'admin', 'disputes', tab],
    queryFn: () => getSwapDisputes(tab),
  });
  const payouts = useQuery({
    queryKey: ['swap', 'admin', 'payouts'],
    queryFn: getSwapHeldPayouts,
  });

  if (overview.isLoading) return <Screen><LoadingState label="Načítavam…" /></Screen>;

  const o = overview.data;

  const decide = async (dispute: SwapDispute, resolution: SwapResolution) => {
    setError(null);
    const full = resolution === 'refunded';
    try {
      await dialog.confirm({
        title: full ? 'Vrátiť celú sumu' : 'Zamietnuť spor',
        body: full
          ? `Kupujúcemu sa vráti ${formatMoney(dispute.total_cents, dispute.currency)} `
            + 'a predajcovi sa tá suma strhne z knihy.'
          : 'Peniaze pôjdu predajcovi podľa pravidiel platformy.',
        confirmLabel: full ? 'Vrátiť' : 'Zamietnuť',
        destructive: full,
      });
    } catch {
      return;
    }
    setBusy(dispute.dispute_id);
    try {
      const result = await resolveSwapDispute(dispute.dispute_id, resolution);
      await queryClient.invalidateQueries({ queryKey: ['swap', 'admin'] });
      if (result.refund_cents > 0) {
        // Databáza povedala KOĽKO. Peniaze posiela serverová funkcia, ktorá
        // má kľúč — appka tu nesmie tvrdiť, že sú už vrátené.
        setError(null);
      }
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  const release = async (payout: SwapHeldPayout) => {
    setError(null);
    let note: string | null = null;
    if (payout.open_disputes > 0) {
      note = await dialog.prompt({
        title: 'Predajca má otvorený spor',
        body: 'Ak peniaze odídu, nie je ich odkiaľ vrátiť. Napíš, prečo to aj tak uvoľňuješ.',
        placeholder: 'Dôvod',
        required: true,
        multiline: true,
      });
      if (!note) return;
    } else {
      try {
        await dialog.confirm({
          title: 'Uvoľniť výplatu',
          body: `${formatMoney(payout.amount_cents, payout.currency)} pôjde predajcovi `
            + 'pri najbližšom spracovaní.',
          confirmLabel: 'Uvoľniť',
        });
      } catch {
        return;
      }
    }

    setBusy(payout.payout_id);
    try {
      await releaseSellerPayout(payout.payout_id, note ?? undefined);
      await queryClient.invalidateQueries({ queryKey: ['swap', 'admin'] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen scroll>
      <Title>{SWAP_BRAND}</Title>

      {o ? (
        <View style={styles.grid}>
          <Stat label="V ponuke" value={String(o.live_listings)} />
          <Stat label="Otvorené spory" value={String(o.open_disputes)}
                tone={o.open_disputes > 0 ? 'warn' : undefined} />
          <Stat label="Čaká na doručenie" value={String(o.awaiting_delivery)}
                tone={o.awaiting_delivery > 0 ? 'warn' : undefined} />
          <Stat label="Zadržané výplaty" value={String(o.held_payouts)}
                tone={o.held_payouts > 0 ? 'warn' : undefined} />
          <Stat label="Obrat" value={formatMoney(o.gmv_cents, o.currency)} />
          <Stat label="Príjem platformy" value={formatMoney(o.revenue_cents, o.currency)} />
        </View>
      ) : null}

      {error ? <Notice tone="danger" title="Nepodarilo sa" body={error} /> : null}

      <SectionHeader title="Spory" />
      <View style={styles.tabs}>
        {(['open', 'resolved'] as const).map((key) => (
          <Pressable
            key={key}
            onPress={() => setTab(key)}
            style={[styles.tab, tab === key && styles.tabOn]}
          >
            <Text style={[styles.tabLabel, tab === key && styles.tabLabelOn]}>
              {key === 'open' ? 'Otvorené' : 'Uzavreté'}
            </Text>
          </Pressable>
        ))}
      </View>

      {(disputes.data ?? []).length === 0 ? (
        <Caption style={styles.empty}>
          {tab === 'open' ? 'Žiadne otvorené spory.' : 'Zatiaľ nič uzavreté.'}
        </Caption>
      ) : (
        (disputes.data ?? []).map((dispute) => (
          <DisputeCard
            key={dispute.dispute_id}
            dispute={dispute}
            busy={busy === dispute.dispute_id}
            onRefund={() => void decide(dispute, 'refunded')}
            onReject={() => void decide(dispute, 'no_action')}
          />
        ))
      )}

      <SectionHeader title="Výplaty" />
      {(payouts.data ?? []).length === 0 ? (
        <Caption style={styles.empty}>Žiadne čakajúce výplaty.</Caption>
      ) : (
        (payouts.data ?? []).map((payout) => (
          <PayoutCard
            key={payout.payout_id}
            payout={payout}
            busy={busy === payout.payout_id}
            onRelease={() => void release(payout)}
          />
        ))
      )}
    </Screen>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <View style={[styles.stat, tone === 'warn' && styles.statWarn]}>
      <Text style={[styles.statValue, tone === 'warn' && styles.statValueWarn]}>{value}</Text>
      <Caption style={styles.statLabel}>{label}</Caption>
    </View>
  );
}

const REASON_LABEL: Record<string, string> = {
  not_received: 'Vstupenka nedorazila',
  invalid: 'Vstupenka nefunguje',
  not_as_described: 'Iná, než bola v ponuke',
  event_cancelled: 'Event bol zrušený',
  other: 'Iné',
};

function DisputeCard({
  dispute, busy, onRefund, onReject,
}: {
  dispute: SwapDispute;
  busy: boolean;
  onRefund: () => void;
  onReject: () => void;
}) {
  const open = dispute.status === 'open' || dispute.status === 'investigating';

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={styles.cardTitle}>
          <Text style={styles.reason}>{REASON_LABEL[dispute.reason] ?? dispute.reason}</Text>
          <Caption numberOfLines={1}>{dispute.event_title}</Caption>
        </View>
        <Text style={styles.amount}>
          {formatMoney(dispute.total_cents, dispute.currency)}
        </Text>
      </View>

      {dispute.description ? (
        <Caption style={styles.quote}>„{dispute.description}"</Caption>
      ) : null}

      {/* Podklady. Bez nich je rozhodnutie hádanie. */}
      <View style={styles.facts}>
        <Fact label="Druh" value={dispute.source === 'blup' ? 'Overená BLUP' : 'Z inej platformy'} />
        <Fact label="Zaplatené" value={dispute.paid_at ? formatRelative(dispute.paid_at) : '—'} />
        <Fact
          label="Doručené"
          value={dispute.delivered_at
            ? `${formatRelative(dispute.delivered_at)}${dispute.has_file ? ' · súbor' : ''}`
            : 'nie'}
        />
        <Fact label="Kupujúci" value={dispute.buyer_name ?? '—'} />
        <Fact label="Predajca" value={dispute.seller_name ?? '—'} />
        <Fact
          label="Riziko predajcu"
          value={`${dispute.seller_risk}${dispute.seller_disputes > 1
            ? ` · ${dispute.seller_disputes} sporov` : ''}`}
          tone={dispute.seller_risk === 'high' ? 'warn' : undefined}
        />
      </View>

      {dispute.transfer_note ? (
        <Caption style={styles.quote}>Predajca napísal: „{dispute.transfer_note}"</Caption>
      ) : null}

      {open ? (
        <View style={styles.actions}>
          <Button
            title={busy ? 'Moment…' : 'Vrátiť kupujúcemu'}
            variant="danger"
            onPress={onRefund}
            disabled={busy}
            style={styles.action}
          />
          <Button
            title="Zamietnuť"
            variant="secondary"
            onPress={onReject}
            disabled={busy}
            style={styles.action}
          />
        </View>
      ) : (
        <Caption style={styles.resolved}>
          {dispute.resolution === 'refunded' ? 'Vrátené'
            : dispute.resolution === 'partially_refunded' ? 'Vrátené čiastočne'
              : 'Zamietnuté'}
          {dispute.refunded_cents
            ? ` · ${formatMoney(dispute.refunded_cents, dispute.currency)}`
            : ''}
        </Caption>
      )}
    </View>
  );
}

function PayoutCard({
  payout, busy, onRelease,
}: {
  payout: SwapHeldPayout;
  busy: boolean;
  onRelease: () => void;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={styles.cardTitle}>
          <Text style={styles.reason}>{payout.seller_name ?? 'Predajca'}</Text>
          <Caption>{formatRelative(payout.requested_at)}</Caption>
        </View>
        <Text style={styles.amount}>
          {formatMoney(payout.amount_cents, payout.currency)}
        </Text>
      </View>

      {payout.held_reason ? (
        <Notice tone="warning" title="Zadržané" body={payout.held_reason} />
      ) : null}

      {payout.open_disputes > 0 ? (
        <Caption style={styles.warn}>
          Má {payout.open_disputes} {payout.open_disputes === 1 ? 'otvorený spor' : 'otvorené spory'}.
          Ak peniaze odídu, nie je ich odkiaľ vrátiť.
        </Caption>
      ) : null}

      {payout.held_reason ? (
        <Button
          title={busy ? 'Moment…' : 'Uvoľniť'}
          onPress={onRelease}
          disabled={busy}
        />
      ) : (
        <Caption>Čaká na najbližšie spracovanie.</Caption>
      )}
    </View>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <View style={styles.fact}>
      <Caption style={styles.factLabel}>{label}</Caption>
      <Text style={[styles.factValue, tone === 'warn' && styles.factWarn]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm,
    marginBottom: spacing.md,
    maxWidth: CONTENT_MAX, width: '100%', alignSelf: 'center',
  },
  stat: {
    minWidth: 140, flexGrow: 1,
    padding: spacing.md, borderRadius: radius.card,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
    gap: 2,
  },
  statWarn: { borderColor: colors.warning, backgroundColor: colors.warningSoft },
  statValue: { ...typography.subheading, color: colors.text },
  statValueWarn: { color: colors.warning },
  statLabel: {},

  tabs: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.sm },
  tab: {
    paddingHorizontal: spacing.md, paddingVertical: 6,
    borderRadius: radius.chip, borderWidth: 1, borderColor: colors.border,
  },
  tabOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  tabLabel: { ...typography.metaSm, color: colors.textSecondary },
  tabLabelOn: { color: '#FFFFFF', fontWeight: '700' },

  card: {
    padding: spacing.md, borderRadius: radius.card,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
    gap: spacing.sm, marginBottom: spacing.sm,
    maxWidth: CONTENT_MAX, width: '100%', alignSelf: 'center',
  },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  cardTitle: { flex: 1 },
  reason: { ...typography.bodyStrong, color: colors.text },
  amount: { ...typography.subheading, color: colors.text },
  quote: { fontStyle: 'italic', lineHeight: 18 },

  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  fact: { minWidth: 120, flexGrow: 1 },
  factLabel: { fontSize: 11 },
  factValue: { ...typography.metaSm, color: colors.text },
  factWarn: { color: colors.warning, fontWeight: '700' },

  actions: { flexDirection: 'row', gap: spacing.sm },
  action: { flex: 1 },
  resolved: { color: colors.textSecondary },
  warn: { color: colors.warning },
  empty: { marginBottom: spacing.md },
});
