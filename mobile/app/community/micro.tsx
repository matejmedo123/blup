import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getMyCommunities, getCommunityEvents } from '@/api/communities';
import { messageFor } from '@/lib/errors';
import { EventCard } from '@/components/EventCard';
import { Body, ErrorState, LoadingState, Screen, SectionHeader } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Micro-eventy.
 *
 * Small events hosted inside a community — workshops, meetups — collected from
 * every community you belong to. Hosting one requires membership, which the
 * database enforces, so this list is exactly what your groups are doing.
 */
export default function MicroEventsScreen() {
  const communities = useQuery({ queryKey: ['communities', 'mine'], queryFn: getMyCommunities });

  const events = useQuery({
    queryKey: ['micro-events', (communities.data ?? []).map((c) => c.id)],
    enabled: Boolean(communities.data),
    queryFn: async () => {
      const lists = await Promise.all(
        (communities.data ?? []).map(async (community) => {
          const list = await getCommunityEvents(community.id, 10);
          return list.map((event) => ({ event, community }));
        }),
      );

      return lists
        .flat()
        .sort((a, b) => new Date(a.event.start_at).getTime() - new Date(b.event.start_at).getTime());
    },
  });

  if (communities.isLoading || events.isLoading) {
    return <Screen><LoadingState label="Načítavam micro-eventy…" /></Screen>;
  }

  if (events.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(events.error)} onRetry={() => void events.refetch()} />
      </Screen>
    );
  }

  if ((communities.data ?? []).length === 0) {
    return (
      <Screen scroll>
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Najprv sa pridaj do komunity</Text>
          <Body muted>
            Micro-eventy sú malé akcie vnútri komunít — workshop, meetup, spoločný tréning.
            Uvidíš tie z komunít, ktorých si členom.
          </Body>
          <Pressable style={styles.cta} onPress={() => router.push('/community')}>
            <Text style={styles.ctaLabel}>Prejsť na komunity</Text>
          </Pressable>
        </View>
      </Screen>
    );
  }

  return (
    <Screen contentStyle={styles.container}>
      <FlatList
        data={events.data ?? []}
        keyExtractor={(item) => item.event.id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshing={events.isRefetching}
        onRefresh={() => void events.refetch()}
        ListHeaderComponent={
          <View>
            <Text style={styles.title}>Micro-eventy</Text>
            <Body muted style={styles.intro}>
              Malé akcie z komunít, ktorých si členom. Založiť micro-event môžeš priamo
              v komunite.
            </Body>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.item}>
            <Pressable onPress={() => router.push(`/community/${item.community.id}`)}>
              <Text style={styles.host}>◈ {item.community.name}</Text>
            </Pressable>
            <EventCard
              event={item.event}
              onPress={() => router.push(`/event/${item.event.id}`)}
            />
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Zatiaľ žiadne micro-eventy</Text>
            <Body muted>
              Tvoje komunity zatiaľ nič nechystajú. Založ prvý — stačí byť členom.
            </Body>
            <Pressable style={styles.cta} onPress={() => router.push('/organizer/create')}>
              <Text style={styles.ctaLabel}>Vytvoriť micro-event</Text>
            </Pressable>
          </View>
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { padding: 0 },
  list: { padding: spacing.gutter, paddingBottom: spacing.xxxl, flexGrow: 1 },
  title: { ...typography.screenTitle, color: colors.text },
  intro: { marginTop: spacing.sm, marginBottom: spacing.xl },

  item: { marginBottom: spacing.xl, gap: spacing.sm },
  host: { ...typography.monoSm, color: colors.purple },

  empty: {
    padding: spacing.xl,
    borderRadius: radius.card,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    gap: spacing.md,
  },
  emptyTitle: { ...typography.subheading, color: colors.text },
  cta: {
    height: 46,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaLabel: { ...typography.buttonSm, color: '#FFFFFF' },
});
