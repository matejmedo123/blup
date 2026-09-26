import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import { getMyTickets } from '@/api/tickets';
import { SignInInvite } from '@/components/SignInInvite';
import { messageFor } from '@/lib/errors';
import { formatEventDate, formatPrice } from '@/lib/format';
import { ticketStatusLabel } from '@/lib/labels';
import { Badge, Caption, EmptyState, ErrorState, LoadingState, Screen } from '@/components/ui';
import { MySwapOrders } from '@/components/MySwapOrders';
import { colors, radius, spacing, typography } from '@/theme';
import type { TicketStatus } from '@/types/models';

const TONE: Record<TicketStatus, 'success' | 'neutral' | 'danger' | 'warning'> = {
  valid: 'success',
  used: 'neutral',
  refunded: 'warning',
  cancelled: 'danger',
};

export default function TicketsScreen() {
  const { isGuest } = useAuth();

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['tickets', 'mine'],
    queryFn: getMyTickets,
    enabled: !isGuest,
  });

  // "Zatiaľ žiadne vstupenky" would suggest the tickets are somewhere else in
  // this account. There is no account.
  if (isGuest) {
    return (
      <SignInInvite
        glyph="🎫"
        title="Vstupenky nájdeš po prihlásení"
        body="Kúpené vstupenky sa viažu na účet — nájdeš ich tu aj v e-maile, a QR kód funguje aj bez signálu."
      />
    );
  }

  if (isLoading) return <Screen><LoadingState label="Načítavam tvoje vstupenky…" /></Screen>;

  if (isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(error)} onRetry={() => void refetch()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <FlatList
        data={data ?? []}
        // Objednávky zo SWAPu patria sem a nie na vlastnú obrazovku: kto kúpil
        // vstupenku, hľadá ju tam, kde má ostatné. Schovať ju inam znamená, že
        // si otvorí prázdne „moje vstupenky" a bude myslieť, že nákup zlyhal.
        ListFooterComponent={<MySwapOrders />}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshing={isRefetching}
        onRefresh={() => void refetch()}
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.ticket, pressed && styles.ticketPressed]}
            onPress={() => router.push(`/tickets/${item.id}`)}
          >
            <View style={styles.stub}>
              <Text style={styles.stubEmoji}>🎫</Text>
            </View>

            <View style={styles.flex}>
              <Text style={styles.title} numberOfLines={1}>
                {item.event?.title ?? 'Event'}
              </Text>
              {item.event ? <Caption>{formatEventDate(item.event.start_at)}</Caption> : null}
              {item.event?.venue_name ? <Caption>{item.event.venue_name}</Caption> : null}
              <Caption style={styles.code}>{item.code}</Caption>
            </View>

            <View style={styles.right}>
              <Badge tone={TONE[item.status]} label={ticketStatusLabel[item.status]} />
              <Caption>{formatPrice(item.price_cents, item.currency)}</Caption>
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          <EmptyState
            emoji="🎟️"
            title="Zatiaľ žiadne vstupenky"
            body="Keď si kúpiš vstupenku, pristane tu aj s QR kódom, ktorý ukážeš pri vstupe — funguje aj offline."
            actionLabel="Nájdi si, kam ísť"
            onAction={() => router.replace('/search')}
          />
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
  list: { padding: spacing.lg, gap: spacing.md, flexGrow: 1 },

  ticket: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  ticketPressed: { backgroundColor: colors.surfacePressed },

  stub: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stubEmoji: { fontSize: 22 },

  title: { ...typography.bodyStrong, color: colors.text },
  code: { color: colors.textTertiary, marginTop: 2, letterSpacing: 1 },
  right: { alignItems: 'flex-end', gap: spacing.xs },
});
