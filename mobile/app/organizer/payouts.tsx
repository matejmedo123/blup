import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';

import {
  getLedger, getMyOrganizations, getOrganizerBalance, getPayouts, refreshPayoutStatus,
  requestPayout, startPayoutOnboarding,
} from '@/api/organizations';
import { payoutStatusLabel } from '@/lib/labels';
import { messageFor } from '@/lib/errors';
import { openExternal } from '@/lib/external';
import { formatMoney, formatRelative } from '@/lib/format';
import {
  Badge, Body, Button, Caption, Divider, EmptyState, Input, LoadingState, Notice, Screen,
  SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';
import type { PayoutStatus } from '@/types/models';

/**
 * What the organizer is told about how long their money is held.
 *
 * The numbers themselves live in the `payout_tiers` table, because they belong
 * in an annex to the contract and have to be changeable without a deployment.
 * These are only the names.
 */
const TIER_LABEL: Record<number, string> = {
  0: 'Nový organizátor',
  1: '1–2 eventy',
  2: '3+ bez incidentu',
};

function releaseLabel(iso: string | null): string | null {
  if (!iso) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleDateString('sk-SK', { day: 'numeric', month: 'long', year: 'numeric' });
}

const TONE: Record<PayoutStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  paid: 'success',
  processing: 'warning',
  pending: 'warning',
  failed: 'danger',
  cancelled: 'neutral',
};

/**
 * Balance & payouts.
 *
 * The amounts here are the real ledger: every ticket sale writes +gross and
 * −BLUP fee, every payout writes a negative entry. Withdrawing is bounded by
 * the settled balance in the database, not by anything this screen believes.
 */
export default function PayoutsScreen() {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [onboardError, setOnboardError] = useState<string | null>(null);

  const organizations = useQuery({ queryKey: ['organizations', 'mine'], queryFn: getMyOrganizations });
  const organization = organizations.data?.[0];

  const balance = useQuery({
    queryKey: ['organization', organization?.id, 'balance'],
    queryFn: () => getOrganizerBalance(organization!.id),
    enabled: Boolean(organization?.id),
  });

  const payouts = useQuery({
    queryKey: ['organization', organization?.id, 'payouts'],
    queryFn: () => getPayouts(organization!.id),
    enabled: Boolean(organization?.id),
  });

  const ledger = useQuery({
    queryKey: ['organization', organization?.id, 'ledger'],
    queryFn: () => getLedger(organization!.id, 30),
    enabled: Boolean(organization?.id),
  });

  if (organizations.isLoading) return <Screen><LoadingState /></Screen>;

  if (!organization) {
    return (
      <Screen>
        <EmptyState emoji="🏢" title="Žiadna organizácia" body="Najprv si nejakú vytvor, aby si videl zostatok." />
      </Screen>
    );
  }

  const onboard = async () => {
    setOnboardError(null);
    setError(null);

    // Stripe refuses KYC for an organization BLUP has not verified, and the
    // Edge Function refuses it before Stripe does. Sending the user to a button
    // that can only fail is worse than sending them to the form that unblocks
    // it, so do that instead of a round trip to an error.
    if (organization.verification_status !== 'verified') {
      router.push('/organizer/verification');
      return;
    }

    setBusy('onboard');
    try {
      const result = await startPayoutOnboarding(organization.id);
      if (!result.onboarding_url) {
        // The function answered, but without a link there is nowhere to send
        // the user — say so rather than letting the button look inert.
        setOnboardError(
          'Poskytovateľ platieb nevrátil odkaz na onboarding. Skús to o chvíľu znova.',
        );
        return;
      }
      await openExternal(result.onboarding_url);
      // Re-read the capability flags once the user comes back.
      await refreshPayoutStatus(organization.id);
      await queryClient.invalidateQueries({ queryKey: ['organizations'] });
      setNotice('Onboarding otvorený. Stav výplat sa aktualizuje, keď to poskytovateľ potvrdí.');
    } catch (caught) {
      setOnboardError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  const withdraw = async () => {
    setError(null);
    setNotice(null);

    const value = Number(amount.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      setError('Zadaj, koľko chceš vybrať.');
      return;
    }

    const cents = Math.round(value * 100);
    if (cents > (balance.data?.available_cents ?? 0)) {
      setError('To je viac, než máš k dispozícii.');
      return;
    }

    setBusy('withdraw');
    try {
      const result = await requestPayout(organization.id, cents);
      setAmount('');
      const STATUS: Record<string, string> = {
        pending: 'čaká na spracovanie',
        processing: 'sa spracúva',
        paid: 'je vyplatená',
        failed: 'zlyhala',
        cancelled: 'bola zrušená',
      };
      setNotice(
        result.note ??
          `Výplata ${formatMoney(result.amount_cents, result.currency)} ${STATUS[result.status] ?? result.status}.`,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['organization', organization.id, 'balance'] }),
        queryClient.invalidateQueries({ queryKey: ['organization', organization.id, 'payouts'] }),
      ]);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  const currency = balance.data?.currency ?? organization.default_currency;

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Nepodarilo sa dokončiť" body={error} /> : null}
      {notice ? <Notice tone="accent" title="Výplata" body={notice} /> : null}

      <View style={styles.hero}>
        <Caption>K výberu</Caption>
        <Text style={styles.heroValue}>
          {formatMoney(balance.data?.available_cents ?? 0, currency)}
        </Text>
        <Caption>
          {formatMoney(balance.data?.pending_cents ?? 0, currency)} ešte dozrieva
        </Caption>
        {(balance.data?.reserve_cents ?? 0) > 0 ? (
          <Caption>
            z toho {formatMoney(balance.data?.reserve_cents ?? 0, currency)} rezerva
          </Caption>
        ) : null}
        {releaseLabel(balance.data?.next_release_at ?? null) ? (
          <Caption>
            najbližšie uvoľnenie {releaseLabel(balance.data?.next_release_at ?? null)}
          </Caption>
        ) : null}
      </View>

      {balance.data?.payouts_frozen ? (
        <Notice
          tone="danger"
          title="Výplaty sú pozastavené"
          body={
            'Zákazník napadol platbu u svojej banky. Kým sa spor neuzavrie, ' +
            'z BLUPu neodídu žiadne peniaze. Pošli nám podklady k podujatiu čo ' +
            'najskôr — banka má na rozhodnutie lehotu a po nej sa už nedá nič robiť.'
          }
        />
      ) : null}

      {balance.data?.payout_tier != null ? (
        <Notice
          tone="accent"
          title={`Tvoja úroveň výplat: ${TIER_LABEL[balance.data.payout_tier] ?? balance.data.payout_tier}`}
          body={
            'Peniaze z predaja sa uvoľňujú až po skončení podujatia, nie po ' +
            'predaji vstupenky — spor o „služba nebola poskytnutá“ vie prísť aj ' +
            'mesiace po akcii. Časť sumy držíme ako rezervu ešte dlhšie. Čím ' +
            'viac odohraných eventov bez incidentu, tým skôr a tým viac dostaneš.'
          }
        />
      ) : null}

      <View style={styles.summary}>
        <SummaryRow label="Hrubý predaj vstupeniek" value={formatMoney(balance.data?.gross_sales_cents ?? 0, currency)} />
        <SummaryRow
          label={`BLUP fee (${(organization.platform_fee_bps / 100).toFixed(2)}%)`}
          value={`− ${formatMoney(balance.data?.platform_fee_cents ?? 0, currency)}`}
        />
        <SummaryRow label="Už vyplatené" value={`− ${formatMoney(balance.data?.paid_out_cents ?? 0, currency)}`} />
        <Divider />
        <SummaryRow label="Tvoj zostatok" value={formatMoney(balance.data?.balance_cents ?? 0, currency)} strong />
      </View>

      {!organization.payouts_enabled ? (
        <>
          <Notice
            tone="warning"
            title={
              organization.verification_status === 'verified'
                ? 'Onboarding výplat nie je dokončený'
                : 'Najprv overenie organizácie'
            }
            body={
              organization.verification_status === 'verified'
                ? 'Kým peniaze odídu z BLUPu, poskytovateľ platieb potrebuje tvoju identitu a bankové údaje (KYC). Je to zákonná požiadavka, nie výmysel BLUPu.'
                : 'Onboarding výplat sa dá spustiť až po tom, čo BLUP overí tvoju organizáciu. Vyplň žiadosť o overenie — trvá to pár minút.'
            }
            actionLabel={
              busy === 'onboard'
                ? 'Otváram…'
                : organization.verification_status === 'verified'
                  ? 'Spustiť onboarding výplat'
                  : 'Vyplniť žiadosť o overenie'
            }
            onAction={busy === 'onboard' ? undefined : onboard}
          />
          {onboardError ? (
            <Notice tone="danger" title="Onboarding sa nespustil" body={onboardError} />
          ) : null}
        </>
      ) : null}

      <SectionHeader title="Výber" />
      <Input
        label={`Suma (${currency})`}
        value={amount}
        onChangeText={setAmount}
        placeholder="0.00"
        keyboardType="decimal-pad"
        editable={organization.payouts_enabled}
        returnKeyType="done"
        onSubmitEditing={() => { if (organization.payouts_enabled) void withdraw(); }}
        hint={
          balance.data?.payouts_frozen
            ? 'Výplaty sú pozastavené pre otvorený spor o platbu.'
            : organization.payouts_enabled
              ? 'Pôjde na bankový účet, ktorý si pripojil pri onboardingu.'
              : 'Dokonči onboarding výplat, aby si mohol vyberať.'
        }
      />
      <Button
        title="Požiadať o výplatu"
        onPress={withdraw}
        loading={busy === 'withdraw'}
        disabled={
          !organization.payouts_enabled
          || Boolean(balance.data?.payouts_frozen)
          || (balance.data?.available_cents ?? 0) <= 0
        }
      />

      <SectionHeader title="História výplat" />
      {(payouts.data ?? []).length === 0 ? (
        <Body muted>Zatiaľ žiadne výplaty.</Body>
      ) : (
        (payouts.data ?? []).map((payout) => (
          <View key={payout.id} style={styles.row}>
            <View style={styles.flex}>
              <Text style={styles.rowTitle}>{formatMoney(payout.amount_cents, payout.currency)}</Text>
              <Caption>{formatRelative(payout.requested_at)}</Caption>
              {payout.failure_reason ? (
                <Caption style={styles.failure}>{payout.failure_reason}</Caption>
              ) : null}
            </View>
            <Badge tone={TONE[payout.status]} label={payoutStatusLabel[payout.status]} />
          </View>
        ))
      )}

      <SectionHeader title="Transakcie" />
      {(ledger.data ?? []).length === 0 ? (
        <Body muted>Zatiaľ nič — naplní sa to, ako sa budú predávať vstupenky.</Body>
      ) : (
        (ledger.data ?? []).map((entry) => (
          <View key={entry.id as string} style={styles.row}>
            <View style={styles.flex}>
              <Text style={styles.rowTitle}>{String(entry.description ?? entry.type)}</Text>
              <Caption>{formatRelative(entry.created_at as string)}</Caption>
            </View>
            <Text
              style={[
                styles.amount,
                { color: (entry.amount_cents as number) >= 0 ? colors.success : colors.textSecondary },
              ]}
            >
              {(entry.amount_cents as number) >= 0 ? '+' : '−'}
              {formatMoney(Math.abs(entry.amount_cents as number), entry.currency as string)}
            </Text>
          </View>
        ))
      )}
    </Screen>
  );
}

function SummaryRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.summaryRow}>
      <Caption>{label}</Caption>
      <Text style={[styles.summaryValue, strong && styles.summaryValueStrong]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },

  hero: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xl },
  heroValue: { ...typography.display, color: colors.text },

  summary: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  summaryValue: { ...typography.body, color: colors.textSecondary },
  summaryValueStrong: { ...typography.subheading, color: colors.text },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowTitle: { ...typography.bodyStrong, color: colors.text },
  amount: { ...typography.bodyStrong },
  failure: { color: colors.danger },
});
