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
 * What the communities you belong to are putting on.
 *
 * These are ordinary events that name a community as their host, gathered from
 * every community you are in. "Micro-event" was the word for them and it is
 * gone from the screen: it named nothing a person recognises, and worse, it
 * suggested they were somehow smaller or private, which they are not — a
 * community event with public visibility is visible to everyone, exactly like
 * any other. The community is who is putting it on, not who may see it.
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
    return <Screen><LoadingState label="Pozerám, čo tvoje komunity chystajú…" /></Screen>;
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
            Komunity tu organizujú vlastné akcie — workshop, meetup, spoločný tréning.
            Keď sa do niektorej pridáš, uvidíš tu všetko, čo chystá.
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
            <Text style={styles.title}>Čo chystajú tvoje komunity</Text>
            <Body muted style={styles.intro}>
              Akcie od komunít, v ktorých si. Keď vytváraš event, môžeš ako organizátora
              uviesť ktorúkoľvek z nich — objaví sa potom aj tu.
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
            <Text style={styles.emptyTitle}>Zatiaľ nič nechystajú</Text>
            <Body muted>
              Tvoje komunity zatiaľ nemajú naplánovanú žiadnu akciu. Prvú môžeš
              zorganizovať ty — stačí byť členom.
            </Body>
            <Pressable style={styles.cta} onPress={() => router.push('/organizer/create')}>
              <Text style={styles.ctaLabel}>Zorganizovať akciu</Text>
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
