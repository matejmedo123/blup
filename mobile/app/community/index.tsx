import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getCommunities, getMyCommunities, type Community } from '@/api/communities';
import { messageFor } from '@/lib/errors';
import { formatCount } from '@/lib/format';
import { GradientCover } from '@/components/GradientCover';
import {
  Button, EmptyState, ErrorState, Chip, Input, LoadingState, Mono, Screen, SectionHeader,
} from '@/components/ui';
import { colors, labelFor, radius, spacing, typography } from '@/theme';

const CATEGORIES = [
  'tech', 'startups', 'techno', 'indie', 'running', 'climbing', 'yoga',
  'food', 'coffee', 'art', 'cinema', 'board-games', 'nightlife', 'volunteering',
];

/** Komunity — themed groups, the "záujmové komunity" of the concept document. */
export default function CommunitiesScreen() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);

  const mine = useQuery({ queryKey: ['communities', 'mine'], queryFn: getMyCommunities });

  const all = useQuery({
    queryKey: ['communities', query, category],
    queryFn: () => getCommunities({ query, category: category ?? undefined }),
  });

  if (all.isLoading) return <Screen><LoadingState label="Načítavam komunity…" /></Screen>;

  if (all.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(all.error)} onRetry={() => void all.refetch()} />
      </Screen>
    );
  }

  const myIds = new Set((mine.data ?? []).map((community) => community.id));

  return (
    <Screen contentStyle={styles.container}>
      <View style={styles.header}>
        <Mono accent>◈ komunity</Mono>
        <Text style={styles.title}>Nájdi si svoju partiu</Text>

        <Input
          value={query}
          onChangeText={setQuery}
          placeholder="Hľadaj komunitu"
          autoCapitalize="none"
          style={styles.search}
        />
      </View>

      <FlatList
        data={all.data ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View>
            <FlatList
              horizontal
              data={CATEGORIES}
              keyExtractor={(item) => item}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
              renderItem={({ item }) => (
                <Chip
                  label={labelFor(item)}
                  selected={category === item}
                  onPress={() => setCategory(category === item ? null : item)}
                />
              )}
            />

            {(mine.data ?? []).length > 0 ? (
              <>
                <SectionHeader title="Tvoje komunity" />
                <FlatList
                  horizontal
                  data={mine.data ?? []}
                  keyExtractor={(item) => item.id}
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.mineRow}
                  renderItem={({ item }) => (
                    <Pressable
                      style={styles.mineCard}
                      onPress={() => router.push(`/community/${item.id}`)}
                    >
                      <GradientCover uri={item.cover_url} seed={item.id} height={72} showPlaceholderLabel={false} />
                      <Text style={styles.mineName} numberOfLines={2}>{item.name}</Text>
                      <Mono style={styles.mineMeta}>{formatCount(item.member_count)} členov</Mono>
                    </Pressable>
                  )}
                />
              </>
            ) : null}

            <SectionHeader
              title="Objav"
              action="Založiť"
              onAction={() => router.push('/community/new')}
            />
          </View>
        }
        renderItem={({ item }) => (
          <CommunityRow
            community={item}
            joined={myIds.has(item.id)}
            onPress={() => router.push(`/community/${item.id}`)}
          />
        )}
        ListEmptyComponent={
          <EmptyState
            emoji="👥"
            title={query ? 'Nič sa nezhoduje' : 'Zatiaľ žiadne komunity'}
            body="Komunita je tematická skupina — techno, startupy, lezenie. Založ prvú."
            actionLabel="Založiť komunitu"
            onAction={() => router.push('/community/new')}
          />
        }
      />
    </Screen>
  );
}

function CommunityRow({
  community, joined, onPress,
}: {
  community: Community;
  joined: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <GradientCover
        uri={community.cover_url}
        seed={community.id}
        height={64}
        style={styles.rowCover}
        showPlaceholderLabel={false}
      />

      <View style={styles.flex}>
        <Text style={styles.rowName} numberOfLines={1}>{community.name}</Text>
        <Mono style={styles.rowMeta}>
          {labelFor(community.category)} · {formatCount(community.member_count)} členov
          {community.city ? ` · ${community.city}` : ''}
        </Mono>
        {community.description ? (
          <Text style={styles.rowDescription} numberOfLines={2}>{community.description}</Text>
        ) : null}
      </View>

      {joined ? (
        <View style={styles.joinedPill}><Mono style={styles.joinedText}>SI TAM</Mono></View>
      ) : (
        <Button title="Pozrieť" variant="ghost" compact onPress={onPress} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { paddingTop: spacing.md },
  flex: { flex: 1 },

  header: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  title: { ...typography.title, color: colors.text },
  search: { marginBottom: 0 },

  list: { padding: spacing.lg, paddingBottom: spacing.xxxl, flexGrow: 1 },
  chipRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },

  mineRow: { gap: spacing.md, paddingBottom: spacing.sm },
  mineCard: {
    width: 132,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingBottom: spacing.sm,
  },
  mineName: {
    ...typography.captionStrong,
    color: colors.text,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
  },
  mineMeta: { color: colors.textTertiary, paddingHorizontal: spacing.sm },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  rowPressed: { backgroundColor: colors.surfacePressed },
  rowCover: { width: 64, borderRadius: radius.md },
  rowName: { ...typography.subheading, color: colors.text },
  rowMeta: { color: colors.textTertiary, marginTop: 2 },
  rowDescription: { ...typography.caption, color: colors.textSecondary, marginTop: 4 },

  joinedPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
  },
  joinedText: { color: colors.accentText, fontSize: 9 },
});
