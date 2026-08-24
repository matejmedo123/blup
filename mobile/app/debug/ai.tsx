import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import { useLocation } from '@/hooks/useLocation';
import {
  explainBreakdown, getRankedEvents, getRecentRecommendationRuns, getRecommendationRunItems,
} from '@/api/ai';
import { messageFor } from '@/lib/errors';
import { formatDistance, formatScore } from '@/lib/format';
import {
  Body, Caption, Divider, EmptyState, ErrorState, LoadingState, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';
import type { ScoreBreakdown } from '@/types/models';

/**
 * "Why was this recommended?" (spec §39)
 *
 * Shows the live ranker output with every score component, and the stored runs
 * so you can see exactly what was served earlier. Developer/admin only.
 */
export default function AiDebugScreen() {
  const location = useLocation({ persist: false });
  const [expanded, setExpanded] = useState<string | null>(null);

  const live = useQuery({
    queryKey: ['debug', 'ranker', location.coords],
    queryFn: () => getRankedEvents({ coords: location.coords, limit: 25 }),
  });

  const runs = useQuery({
    queryKey: ['debug', 'runs'],
    queryFn: () => getRecentRecommendationRuns(5),
  });

  const runItems = useQuery({
    queryKey: ['debug', 'run-items', runs.data?.[0]?.id],
    queryFn: () => getRecommendationRunItems(runs.data![0].id),
    enabled: Boolean(runs.data?.[0]?.id),
  });

  if (live.isLoading) return <Screen><LoadingState label="Spúšťam ranker…" /></Screen>;

  if (live.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(live.error)} onRetry={() => void live.refetch()} />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Caption>
        Engine: sql_ranker_v1 · {location.coords ? 'using your GPS position' : 'no location — distance scores are neutral'}
      </Caption>

      <SectionHeader title={`Live ranking · ${live.data?.length ?? 0} events`} />

      {(live.data ?? []).length === 0 ? (
        <EmptyState
          emoji="🧪"
          title="Nie je čo zoraďovať"
          body="Ranker nenašiel žiadne kandidátske eventy. Vytvor nejaké alebo rozšír okruh."
        />
      ) : (
        (live.data ?? []).map((event, index) => {
          const isOpen = expanded === event.id;
          const breakdown = event.score_breakdown as ScoreBreakdown | null;

          return (
            <Pressable
              key={event.id}
              onPress={() => setExpanded(isOpen ? null : event.id)}
              style={styles.card}
            >
              <View style={styles.cardHeader}>
                <Text style={styles.rank}>#{index + 1}</Text>
                <View style={styles.flex}>
                  <Text style={styles.title} numberOfLines={1}>{event.title}</Text>
                  <Caption>
                    {event.category}
                    {event.distance_m !== null ? ` · ${formatDistance(event.distance_m)}` : ''}
                  </Caption>
                </View>
                <Text style={styles.score}>{formatScore(Number(event.score))}</Text>
              </View>

              {isOpen && breakdown ? (
                <View style={styles.breakdown}>
                  {explainBreakdown(breakdown).map((component) => (
                    <View key={component.label} style={styles.componentRow}>
                      <View style={styles.componentHeader}>
                        <Caption>{component.label}</Caption>
                        <Caption>
                          {formatScore(component.value)} × {component.weight} ={' '}
                          {component.contribution.toFixed(3)}
                        </Caption>
                      </View>
                      <View style={styles.bar}>
                        <View style={[styles.barFill, { width: `${Math.round(component.value * 100)}%` }]} />
                      </View>
                    </View>
                  ))}

                  <Divider />

                  <Caption>Fakty, ktoré ranker použil</Caption>
                  <Body muted style={styles.facts}>
                    interest hits: {breakdown.facts.interest_hits} · friends going:{' '}
                    {breakdown.facts.friends_going} · follows creator:{' '}
                    {String(breakdown.facts.follows_creator)} · category affinity:{' '}
                    {breakdown.facts.category_affinity} · distance: {breakdown.facts.distance_m} m
                  </Body>

                  <Caption style={styles.formula}>
                    final = Σ (component × weight) = {Number(event.score).toFixed(4)}
                  </Caption>
                </View>
              ) : null}
            </Pressable>
          );
        })
      )}

      <SectionHeader title="Uložené behy" />
      <Caption style={styles.runsHint}>
        Každé volanie odporúčacieho endpointu sa ukladá aj so skóre, takže vieš spätne overiť, čo
        používateľ naozaj videl.
      </Caption>

      {(runs.data ?? []).length === 0 ? (
        <Body muted>Zatiaľ nie sú zalogované žiadne behy. Otvor domovský feed a jeden vznikne.</Body>
      ) : (
        <>
          {(runs.data ?? []).map((run) => (
            <View key={run.id} style={styles.runRow}>
              <Caption>{new Date(run.created_at).toLocaleString()}</Caption>
              <Caption>{run.context} · {run.engine}</Caption>
            </View>
          ))}

          {(runItems.data ?? []).length > 0 ? (
            <>
              <Caption style={styles.runsHint}>Posledný beh vrátil:</Caption>
              {(runItems.data ?? []).map((item) => (
                <View key={item.event_id} style={styles.runItem}>
                  <Text style={styles.runRank}>#{item.rank}</Text>
                  <Body style={styles.flex} numberOfLines={1}>
                    {item.event?.title ?? item.event_id}
                  </Body>
                  <Caption>{formatScore(Number(item.score))}</Caption>
                </View>
              ))}
            </>
          ) : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rank: { ...typography.caption, color: colors.textTertiary, width: 28 },
  title: { ...typography.bodyStrong, color: colors.text },
  score: { ...typography.subheading, color: colors.accent },

  breakdown: { marginTop: spacing.lg, gap: spacing.md },
  componentRow: { gap: spacing.xs },
  componentHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  bar: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceElevated, overflow: 'hidden' },
  barFill: { height: 6, backgroundColor: colors.accent },
  facts: { fontSize: 12, lineHeight: 18 },
  formula: { color: colors.accent },

  runsHint: { marginBottom: spacing.md },
  runRow: { paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  runItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xs },
  runRank: { ...typography.caption, color: colors.textTertiary, width: 28 },
});
