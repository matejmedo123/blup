import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery } from '@tanstack/react-query';

import {
  getMyOrganizations, getOrganizationEvents, getOrganizerBalance,
} from '@/api/organizations';
import { messageFor } from '@/lib/errors';
import { formatEventDate, formatMoney } from '@/lib/format';
import {
  Avatar, Badge, Body, EmptyState, ErrorState, LoadingState, Mono, Notice, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, shadow, spacing, typography } from '@/theme';

/**
 * Days between a sale and the money becoming withdrawable. Mirrors the
 * `available_at` default in 20260101000600_ticketing_and_payments.sql — the
 * database stays the source of truth, this is only the copy shown to a human.
 */
const SETTLEMENT_DAYS = 7;

const VERIFICATION_LABEL: Record<string, string> = {
  verified: '✓ OVERENÁ',
  pending: 'ČAKÁ NA OVERENIE',
  rejected: 'ZAMIETNUTÁ',
  unverified: 'NEOVERENÁ',
};

const ROLE_LABEL: Record<string, string> = {
  owner: 'majiteľ',
  admin: 'admin',
  event_manager: 'event manažér',
  finance: 'financie',
};

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
          title="Zatiaľ nemáš organizáciu"
          body="Vytvor organizáciu, ak chceš robiť platené eventy, sledovať predaj a dostávať výplaty. Na eventy zdarma ju nepotrebuješ."
          actionLabel="Vytvoriť organizáciu"
          onAction={() => router.push('/organizer/new')}
        />
      </Screen>
    );
  }

  const isVerified = organization.verification_status === 'verified';
  const currency = balance.data?.currency;

  return (
    <Screen scroll contentStyle={styles.content}>
      {/* --- org switcher --------------------------------------------------- */}
      {(organizations.data ?? []).length > 1 ? (
        <View style={styles.switcher}>
          {(organizations.data ?? []).map((org) => (
            <Pressable
              key={org.id}
              onPress={() => setActiveId(org.id)}
              style={[styles.switcherItem, org.id === organization.id && styles.switcherItemActive]}
            >
              <Text
                style={[
                  styles.switcherLabel,
                  org.id === organization.id && styles.switcherLabelActive,
                ]}
              >
                {org.name}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* --- header --------------------------------------------------------- */}
      <View style={styles.header}>
        <Avatar url={organization.logo_url} name={organization.name} size={56} />
        <View style={styles.flex}>
          <Text style={styles.name} numberOfLines={1}>{organization.name}</Text>
          <Mono style={styles.handle}>
            @{organization.slug} · {ROLE_LABEL[organization.my_role] ?? organization.my_role}
          </Mono>
        </View>
        <Badge
          tone={isVerified ? 'success' : organization.verification_status === 'pending' ? 'warning' : 'neutral'}
          label={VERIFICATION_LABEL[organization.verification_status] ?? organization.verification_status}
        />
      </View>

      {!isVerified ? (
        <Notice
          tone="warning"
          title="Na predaj vstupeniek potrebuješ overenie"
          body="BLUP overuje organizátorov skôr, než začnú tiecť peniaze. Chráni to kupujúcich a vďaka tomu ti vieme posielať výplaty."
          actionLabel={organization.verification_status === 'pending' ? 'Zobraziť žiadosť' : 'Požiadať o overenie'}
          onAction={() => router.push('/organizer/verification')}
        />
      ) : null}

      {/* --- money ---------------------------------------------------------- */}
      <SectionHeader title="Zostatok" action="Výplaty" onAction={() => router.push('/organizer/payouts')} />

      <LinearGradient
        colors={['#1E3A8A', '#2B6BFF']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.balanceCard}
      >
        <Mono style={styles.balanceLabel}>K VÝBERU</Mono>
        <Text style={styles.balanceValue}>
          {formatMoney(balance.data?.available_cents ?? 0, currency)}
        </Text>
        <Mono style={styles.balanceHint}>
          čaká na uvoľnenie {formatMoney(balance.data?.pending_cents ?? 0, currency)}
        </Mono>
      </LinearGradient>

      <View style={styles.tileRow}>
        <StatTile label="Hrubý predaj" value={formatMoney(balance.data?.gross_sales_cents ?? 0, currency)} />
        <StatTile label="Poplatok BLUP" value={formatMoney(balance.data?.platform_fee_cents ?? 0, currency)} />
      </View>
      <View style={styles.tileRow}>
        <StatTile label="Vyplatené" value={formatMoney(balance.data?.paid_out_cents ?? 0, currency)} />
        <StatTile label="Celkový zostatok" value={formatMoney(balance.data?.balance_cents ?? 0, currency)} />
      </View>

      <Text style={styles.feeNote}>
        BLUP si berie {(organization.platform_fee_bps / 100).toFixed(2)} % z každej predanej
        vstupenky. Peniaze sa uvoľnia {SETTLEMENT_DAYS} dní po predaji, potom si ich môžeš vybrať.
      </Text>

      {/* --- tools ---------------------------------------------------------- */}
      <SectionHeader title="Nástroje" />
      <View style={styles.tiles}>
        <ToolTile
          glyph="◫"
          label="Skenovať vstupenky"
          detail="pri vstupe"
          onPress={() => router.push('/organizer/scan')}
        />
        <ToolTile
          glyph="€"
          label="Zostatok a výplaty"
          detail="história prevodov"
          onPress={() => router.push('/organizer/payouts')}
        />
      </View>

      {/* --- events --------------------------------------------------------- */}
      <SectionHeader title="Vaše eventy" />
      {(events.data ?? []).length === 0 ? (
        <Body muted>
          Pod touto organizáciou zatiaľ nič nie je zverejnené. Vytvor event a nastav túto
          organizáciu ako usporiadateľa.
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
              <Mono style={styles.eventMeta}>{formatEventDate(event.start_at)}</Mono>
              <Mono style={styles.eventMeta}>
                {event.attendee_count} ide
                {event.is_free ? '' : ` · ${event.tickets_sold} vstupeniek predaných`}
              </Mono>
            </View>

            {!event.is_free ? (
              <>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => router.push(`/organizer/tickets/${event.id}`)}
                  style={({ pressed }) => [styles.eventAction, pressed && styles.eventRowPressed]}
                >
                  <Text style={styles.eventActionLabel}>Vstupenky</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => router.push(`/organizer/promo/${event.id}`)}
                  style={({ pressed }) => [styles.eventAction, pressed && styles.eventRowPressed]}
                >
                  <Text style={styles.eventActionLabel}>Promo</Text>
                </Pressable>
              </>
            ) : null}

            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ))
      )}
    </Screen>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.tile}>
      <Mono style={styles.tileLabel}>{label}</Mono>
      <Text style={styles.tileValue}>{value}</Text>
    </View>
  );
}

function ToolTile({
  glyph, label, detail, onPress,
}: {
  glyph: string;
  label: string;
  detail: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.toolTile, pressed && styles.eventRowPressed]}
    >
      <View style={styles.toolIcon}>
        <Text style={styles.toolGlyph}>{glyph}</Text>
      </View>
      <Text style={styles.toolLabel}>{label}</Text>
      <Mono style={styles.tileLabel}>{detail}</Mono>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { gap: 0 },
  flex: { flex: 1 },

  switcher: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg, flexWrap: 'wrap' },
  switcherItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  switcherItemActive: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  switcherLabel: { ...typography.chip, color: colors.textSecondary },
  switcherLabelActive: { color: colors.accentText },

  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.lg },
  name: { ...typography.heading, color: colors.text },
  handle: { color: colors.textTertiary },

  balanceCard: {
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
    marginBottom: spacing.md,
    ...shadow.card,
  },
  balanceLabel: { color: 'rgba(255, 255, 255, 0.72)' },
  balanceValue: { ...typography.title, color: '#FFFFFF' },
  balanceHint: { color: 'rgba(255, 255, 255, 0.72)' },

  tileRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md },
  tile: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  tileLabel: { color: colors.textTertiary },
  tileValue: { ...typography.subheading, color: colors.text },
  feeNote: { ...typography.caption, color: colors.textTertiary, marginTop: spacing.xs },

  tiles: { flexDirection: 'row', gap: spacing.md },
  toolTile: {
    flex: 1,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  toolIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  toolGlyph: { fontSize: 17, color: colors.textSecondary },
  toolLabel: { ...typography.bodyStrong, color: colors.text },

  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  eventRowPressed: { backgroundColor: colors.surfacePressed },
  eventTitle: { ...typography.bodyStrong, color: colors.text },
  eventMeta: { color: colors.textTertiary, marginTop: 2 },
  eventAction: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
  },
  eventActionLabel: { ...typography.chip, color: colors.accentText },
  chevron: { ...typography.heading, color: colors.textTertiary },
});
