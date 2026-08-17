import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import {
  getMyOrganizations, getOrganizationEvents, getOrganizerBalance,
} from '@/api/organizations';
import { messageFor } from '@/lib/errors';
import { formatEventDate, formatMoney } from '@/lib/format';
import {
  Avatar, Badge, Body, Button, Caption, EmptyState, ErrorState, LoadingState, Notice, Screen,
  SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/** Organizer dashboard: events, sales, balance, verification and the scanner. */
export default function OrganizerDashboard() {
  const [activeId, setActiveId] = useState<string | null>(null);

  const organizations = useQuery({ queryKey: ['organizations', 'mine'], queryFn: getMyOrganizations });

  const organization =
    (organizations.data ?? []).find((org) => org.id === activeId) ?? organizations.data?.[0];

  const balance = useQuery({
    queryKey: ['organization', organization?.id, 'balance'],
    queryFn: () => getOrganizerBalance(organization!.id),
    enabled: Boolean(organization?.id),
  });

  const events = useQuery({
    queryKey: ['organization', organization?.id, 'events'],
    queryFn: () => getOrganizationEvents(organization!.id),
    enabled: Boolean(organization?.id),
  });

  if (organizations.isLoading) return <Screen><LoadingState /></Screen>;

  if (organizations.isError) {
    return (
      <Screen>
        <ErrorState
          message={messageFor(organizations.error)}
          onRetry={() => void organizations.refetch()}
        />
      </Screen>
    );
  }

  if (!organization) {
    return (
      <Screen>
        <EmptyState
          emoji="🏢"
          title="No organizer account yet"
          body="Create an organization to run ticketed events, track sales and get paid out. Free events do not need one."
          actionLabel="Create an organization"
          onAction={() => router.push('/organizer/new')}
        />
      </Screen>
    );
  }

  const isVerified = organization.verification_status === 'verified';

  return (
    <Screen scroll>
      {/* --- org switcher --------------------------------------------------- */}
      {(organizations.data ?? []).length > 1 ? (
        <View style={styles.switcher}>
          {(organizations.data ?? []).map((org) => (
            <Pressable
              key={org.id}
              onPress={() => setActiveId(org.id)}
              style={[styles.switcherItem, org.id === organization.id && styles.switcherItemActive]}
            >
              <Text style={styles.switcherLabel}>{org.name}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={styles.header}>
        <Avatar url={organization.logo_url} name={organization.name} size={56} />
        <View style={styles.flex}>
          <Text style={styles.name}>{organization.name}</Text>
          <Caption>@{organization.slug} · your role: {organization.my_role}</Caption>
        </View>
        <Badge
          tone={isVerified ? 'success' : organization.verification_status === 'pending' ? 'warning' : 'neutral'}
          label={isVerified ? '✓ Verified' : organization.verification_status}
        />
      </View>

      {!isVerified ? (
        <Notice
          tone="warning"
          title="Verification required to sell tickets"
          body="BLUP verifies organizers before money changes hands. It protects buyers and it is what lets us pay you out."
          actionLabel={organization.verification_status === 'pending' ? 'View your request' : 'Apply for verification'}
          onAction={() => router.push('/organizer/verification')}
        />
      ) : null}

      {/* --- money ---------------------------------------------------------- */}
      <SectionHeader title="Balance" action="Payouts" onAction={() => router.push('/organizer/payouts')} />

      <View style={styles.balanceRow}>
        <BalanceTile
          label="Available"
          value={formatMoney(balance.data?.available_cents ?? 0, balance.data?.currency)}
          tone="success"
        />
        <BalanceTile
          label="Pending"
          value={formatMoney(balance.data?.pending_cents ?? 0, balance.data?.currency)}
        />
      </View>

      <View style={styles.balanceRow}>
        <BalanceTile
          label="Gross sales"
          value={formatMoney(balance.data?.gross_sales_cents ?? 0, balance.data?.currency)}
        />
        <BalanceTile
          label="BLUP fee"
          value={formatMoney(balance.data?.platform_fee_cents ?? 0, balance.data?.currency)}
        />
      </View>

      <Caption style={styles.feeNote}>
        BLUP takes {(organization.platform_fee_bps / 100).toFixed(2)}% of each ticket sale. Funds
        settle {7} days after the sale, then you can withdraw them.
      </Caption>

      {/* --- tools ---------------------------------------------------------- */}
      <SectionHeader title="Tools" />
      <View style={styles.tools}>
        <Button title="🎫 Scan tickets at the door" variant="secondary" onPress={() => router.push('/organizer/scan')} />
        <Button title="💸 Balance & payouts" variant="secondary" onPress={() => router.push('/organizer/payouts')} />
      </View>

      {/* --- events --------------------------------------------------------- */}
      <SectionHeader title="Your events" />
      {(events.data ?? []).length === 0 ? (
        <Body muted>
          Nothing published under this organization yet. Create an event and pick this organization
          as the host.
        </Body>
      ) : (
        (events.data ?? []).map((event) => (
          <Pressable
            key={event.id}
            style={({ pressed }) => [styles.eventRow, pressed && styles.eventRowPressed]}
            onPress={() => router.push(`/organizer/analytics/${event.id}`)}
          >
            <View style={styles.flex}>
              <Text style={styles.eventTitle} numberOfLines={1}>{event.title}</Text>
              <Caption>{formatEventDate(event.start_at)}</Caption>
              <Caption>
                {event.attendee_count} going
                {event.is_free ? '' : ` · ${event.tickets_sold} tickets sold`}
              </Caption>
            </View>
            {!event.is_free ? (
              <Button
                title="Tickets"
                variant="ghost"
                compact
                onPress={() => router.push(`/organizer/tickets/${event.id}`)}
              />
            ) : null}
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))
      )}
    </Screen>
  );
}

function BalanceTile({
  label, value, tone,
}: {
  label: string;
  value: string;
  tone?: 'success';
}) {
  return (
    <View style={styles.tile}>
      <Caption>{label}</Caption>
      <Text style={[styles.tileValue, tone === 'success' && { color: colors.success }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },

  switcher: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg, flexWrap: 'wrap' },
  switcherItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  switcherItemActive: { backgroundColor: colors.accentSoft },
  switcherLabel: { ...typography.caption, color: colors.text },

  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  name: { ...typography.heading, color: colors.text },

  balanceRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md },
  tile: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  tileValue: { ...typography.subheading, color: colors.text },
  feeNote: { marginTop: spacing.xs },

  tools: { gap: spacing.sm },

  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
  },
  eventRowPressed: { backgroundColor: colors.surfacePressed },
  eventTitle: { ...typography.bodyStrong, color: colors.text },
  chevron: { ...typography.heading, color: colors.textTertiary },
});
