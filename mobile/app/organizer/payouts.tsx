import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';

import {
  getLedger, getMyOrganizations, getOrganizerBalance, getPayouts, refreshPayoutStatus,
  requestPayout, startPayoutOnboarding,
} from '@/api/organizations';
import { messageFor } from '@/lib/errors';
import { formatMoney, formatRelative } from '@/lib/format';
import {
  Badge, Body, Button, Caption, Divider, EmptyState, Input, LoadingState, Notice, Screen,
  SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';
import type { PayoutStatus } from '@/types/models';

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
        <EmptyState emoji="🏢" title="No organization" body="Create one first to see a balance." />
      </Screen>
    );
  }

  const onboard = async () => {
    setError(null);
    setBusy('onboard');
    try {
      const result = await startPayoutOnboarding(organization.id);
      if (result.onboarding_url) {
        await WebBrowser.openBrowserAsync(result.onboarding_url);
        // Re-read the capability flags once the user comes back.
        await refreshPayoutStatus(organization.id);
        await queryClient.invalidateQueries({ queryKey: ['organizations'] });
        setNotice('Onboarding opened. Your payout status updates once the provider confirms.');
      }
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  const withdraw = async () => {
    setError(null);
    setNotice(null);

    const value = Number(amount.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      setError('Enter how much you want to withdraw.');
      return;
    }

    const cents = Math.round(value * 100);
    if (cents > (balance.data?.available_cents ?? 0)) {
      setError('That is more than your available balance.');
      return;
    }

    setBusy('withdraw');
    try {
      const result = await requestPayout(organization.id, cents);
      setAmount('');
      setNotice(
        result.note ??
          `Payout of ${formatMoney(result.amount_cents, result.currency)} is ${result.status}.`,
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
      {error ? <Notice tone="danger" title="Could not complete" body={error} /> : null}
      {notice ? <Notice tone="accent" title="Payout" body={notice} /> : null}

      <View style={styles.hero}>
        <Caption>Available to withdraw</Caption>
        <Text style={styles.heroValue}>
          {formatMoney(balance.data?.available_cents ?? 0, currency)}
        </Text>
        <Caption>
          {formatMoney(balance.data?.pending_cents ?? 0, currency)} still settling
        </Caption>
      </View>

      <View style={styles.summary}>
        <SummaryRow label="Gross ticket sales" value={formatMoney(balance.data?.gross_sales_cents ?? 0, currency)} />
        <SummaryRow
          label={`BLUP fee (${(organization.platform_fee_bps / 100).toFixed(2)}%)`}
          value={`− ${formatMoney(balance.data?.platform_fee_cents ?? 0, currency)}`}
        />
        <SummaryRow label="Already paid out" value={`− ${formatMoney(balance.data?.paid_out_cents ?? 0, currency)}`} />
        <Divider />
        <SummaryRow label="Your balance" value={formatMoney(balance.data?.balance_cents ?? 0, currency)} strong />
      </View>

      {!organization.payouts_enabled ? (
        <Notice
          tone="warning"
          title="Payout onboarding not finished"
          body="Before money can leave BLUP, the payment provider needs your identity and bank details (KYC). This is a legal requirement, not a BLUP one."
          actionLabel="Start payout onboarding"
          onAction={onboard}
        />
      ) : null}

      <SectionHeader title="Withdraw" />
      <Input
        label={`Amount (${currency})`}
        value={amount}
        onChangeText={setAmount}
        placeholder="0.00"
        keyboardType="decimal-pad"
        editable={organization.payouts_enabled}
        hint={
          organization.payouts_enabled
            ? 'Goes to the bank account you connected during onboarding.'
            : 'Finish payout onboarding to enable withdrawals.'
        }
      />
      <Button
        title="Request payout"
        onPress={withdraw}
        loading={busy === 'withdraw'}
        disabled={!organization.payouts_enabled || (balance.data?.available_cents ?? 0) <= 0}
      />

      <SectionHeader title="Payout history" />
      {(payouts.data ?? []).length === 0 ? (
        <Body muted>No payouts yet.</Body>
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
            <Badge tone={TONE[payout.status]} label={payout.status} />
          </View>
        ))
      )}

      <SectionHeader title="Transactions" />
      {(ledger.data ?? []).length === 0 ? (
        <Body muted>Nothing yet — this fills up as tickets sell.</Body>
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
  flex: { flex: 1 },

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
