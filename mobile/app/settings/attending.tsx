import { eventHref } from '@/lib/format';
import React, { useMemo } from 'react';
import { SectionList, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { eventHasEnded, getAttendingEvents, toFeedItem } from '@/api/events';
import { messageFor } from '@/lib/errors';
import { EventCard } from '@/components/EventCard';
import { EmptyState, ErrorState, LoadingState, Screen } from '@/components/ui';
import { colors, spacing, typography } from '@/theme';
import type { BlupEvent } from '@/types/models';

/**
 * Everything you said you were going to.
 *
 * It used to be one flat list sorted by date, which put a concert from March
 * above next weekend's — the calendar read as though half of it was still
 * ahead. What is still coming goes first, soonest at the top; what has been
 * stays, most recent first, because it is the record of where you were.
 */
export default function AttendingScreen() {
  const query = useQuery({ queryKey: ['events', 'attending'], queryFn: getAttendingEvents });

  const sections = useMemo(() => {
    const all = query.data ?? [];
    const upcoming = all.filter((event) => !eventHasEnded(event));
    const past = all
      .filter((event) => eventHasEnded(event))
      .sort((a, b) => new Date(b.start_at).getTime() - new Date(a.start_at).getTime());

    return [
      ...(upcoming.length ? [{ title: 'Ideš', data: upcoming }] : []),
      ...(past.length ? [{ title: 'Už bolo', data: past }] : []),
    ] as { title: string; data: BlupEvent[] }[];
  }, [query.data]);

  if (query.isLoading) return <Screen><LoadingState /></Screen>;
  if (query.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(query.error)} onRetry={() => void query.refetch()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: spacing.lg, flexGrow: 1 }}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <Text style={styles.heading}>{section.title}</Text>
        )}
        renderItem={({ item, section }) => (
          <View style={[
            { marginBottom: spacing.lg },
            section.title === 'Už bolo' ? styles.past : null,
          ]}>
            <EventCard event={toFeedItem(item)} onPress={() => router.push(eventHref(item))} />
          </View>
        )}
        ListEmptyComponent={
          <EmptyState
            emoji="📅"
            title="V kalendári máš prázdno"
            body="Označ pri evente, že ideš, a objaví sa tu."
            actionLabel="Prezerať eventy"
            onAction={() => router.replace('/search')}
          />
        }
      />
    </Screen>
  );
}

const styles = {
  heading: {
    ...typography.section,
    color: colors.textSecondary,
    marginBottom: spacing.md,
  },
  // Still legible, no longer competing with what is still ahead of you.
  past: { opacity: 0.6 },
} as const;
