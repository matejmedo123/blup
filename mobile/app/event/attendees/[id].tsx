import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getEventAttendees } from '@/api/events';
import { getPeopleRecommendations, describeMatch } from '@/api/ai';
import { messageFor } from '@/lib/errors';
import {
  Avatar, Badge, Caption, EmptyState, ErrorState, LoadingState, Screen, SectionHeader,
} from '@/components/ui';
import { colors, spacing, typography } from '@/theme';

/** Everyone going, plus the BLUP Connect suggestions for this event. */
export default function AttendeesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  const attendees = useQuery({
    queryKey: ['event', id, 'attendees', 'all'],
    queryFn: () => getEventAttendees(id!, 200),
    enabled: Boolean(id),
  });

  const matches = useQuery({
    queryKey: ['event', id, 'connect'],
    queryFn: () => getPeopleRecommendations({ eventId: id, limit: 20 }),
    enabled: Boolean(id),
  });

  if (attendees.isLoading) return <Screen><LoadingState /></Screen>;

  if (attendees.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(attendees.error)} onRetry={() => void attendees.refetch()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <FlatList
        data={attendees.data ?? []}
        keyExtractor={(item) => item.user_id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          (matches.data ?? []).length > 0 ? (
            <View>
              <SectionHeader title="S týmito si môžeš sadnúť" />
              {(matches.data ?? []).slice(0, 5).map((match) => (
                <Pressable
                  key={match.user_id}
                  style={styles.row}
                  onPress={() => router.push(`/user/${match.user_id}`)}
                >
                  <Avatar url={match.avatar_url} name={match.display_name} size={44} />
                  <View style={styles.flex}>
                    <Text style={styles.name}>{match.display_name ?? match.username}</Text>
                    <Caption style={styles.reason}>{describeMatch(match)}</Caption>
                  </View>
                  <Badge tone="accent" label={`${Math.round(match.score * 100)}%`} />
                </Pressable>
              ))}
              <SectionHeader title="Všetci, čo idú" />
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => router.push(`/user/${item.user_id}`)}>
            <Avatar url={item.profile?.avatar_url} name={item.profile?.display_name} size={44} />
            <View style={styles.flex}>
              <Text style={styles.name}>{item.profile?.display_name ?? item.profile?.username}</Text>
              {item.profile?.bio ? <Caption numberOfLines={1}>{item.profile.bio}</Caption> : null}
            </View>
            {item.status === 'checked_in' ? <Badge tone="success" label="Na mieste" /> : null}
          </Pressable>
        )}
        ListEmptyComponent={
          <EmptyState emoji="👥" title="Zatiaľ nikto" body="Buď prvý, kto povie, že ide." />
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
  list: { padding: spacing.lg, flexGrow: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  name: { ...typography.bodyStrong, color: colors.text },
  reason: { color: colors.accent },
});
