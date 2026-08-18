import React from 'react';
import { FlatList, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getSavedEvents } from '@/api/events';
import { messageFor } from '@/lib/errors';
import { EventCard } from '@/components/EventCard';
import { EmptyState, ErrorState, LoadingState, Screen } from '@/components/ui';
import { spacing } from '@/theme';

export default function SavedEventsScreen() {
  const query = useQuery({ queryKey: ['events', 'saved'], queryFn: getSavedEvents });

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
      <FlatList
        data={query.data ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: spacing.lg, flexGrow: 1 }}
        renderItem={({ item }) => (
          <View style={{ marginBottom: spacing.lg }}>
            <EventCard event={item} onPress={() => router.push(`/event/${item.id}`)} />
          </View>
        )}
        ListEmptyComponent={
          <EmptyState
            emoji="⭐"
            title="Zatiaľ nič uložené"
            body="Potiahni doprava na úvodnej obrazovke alebo klikni na hviezdičku pri ktoromkoľvek evente."
            actionLabel="Nájdi si niečo"
            onAction={() => router.replace('/(tabs)')}
          />
        }
      />
    </Screen>
  );
}
