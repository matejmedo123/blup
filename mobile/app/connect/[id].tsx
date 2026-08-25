import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getEvent } from '@/api/events';
import { describeMatch, getPeopleRecommendations } from '@/api/ai';
import type { PeopleMatch } from '@/types/models';
import { messageFor } from '@/lib/errors';
import { profileHref } from '@/lib/format';
import {
  Avatar, Badge, Body, Caption, EmptyState, ErrorState, LoadingState, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Blup Connect for one event.
 *
 * The matching has always existed — shared interests, events you have both
 * been to, people you both follow — but it was an unnamed list halfway down
 * the event page that appeared only when it had something to say. Going to
 * something alone and finding out afterwards that six people you would have
 * got on with were in the same room is the problem BLUP is supposed to solve,
 * so it gets a name, a summary you can see without scrolling, and this screen.
 *
 * Nothing here is a new signal: it is the same recommend_people the row uses,
 * with room to show all of it and to say why each person is on the list.
 */
export default function ConnectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  const event = useQuery({
    queryKey: ['event', id],
    queryFn: () => getEvent(id!),
    enabled: Boolean(id),
  });

  const matches = useQuery({
    queryKey: ['event', id, 'connect', 'all'],
    queryFn: () => getPeopleRecommendations({ eventId: id, limit: 40 }),
    enabled: Boolean(id),
  });

  if (event.isLoading || matches.isLoading) return <Screen><LoadingState /></Screen>;

  if (matches.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(matches.error)} onRetry={() => void matches.refetch()} />
      </Screen>
    );
  }

  const people = matches.data ?? [];
  const friends = people.filter((m) => m.mutual_follows > 0);
  const kindred = people.filter((m) => m.mutual_follows === 0);

  return (
    <Screen scroll>
      <Text style={styles.title}>Blup Connect</Text>
      <Body muted style={styles.intro}>
        {event.data?.title
          ? `Kto ide na ${event.data.title} a s kým si asi sadneš.`
          : 'Ľudia odtiaľto, s ktorými si asi sadneš.'}
      </Body>

      {people.length === 0 ? (
        <EmptyState
          emoji="👋"
          title="Zatiaľ nikto"
          body="Keď sa na tento event prihlási viac ľudí, nájdeme tu tých, s ktorými máš niečo spoločné. Doplň si záujmy v profile — bez nich nemáme čo porovnávať."
          actionLabel="Doplniť záujmy"
          onAction={() => router.push('/settings/interests')}
        />
      ) : null}

      {friends.length > 0 ? (
        <>
          <SectionHeader title={`Cez známych · ${friends.length}`} />
          <Caption style={styles.hint}>Máte spoločných ľudí, ktorých sledujete.</Caption>
          {friends.map((match) => <MatchRow key={match.user_id} match={match} />)}
        </>
      ) : null}

      {kindred.length > 0 ? (
        <>
          <SectionHeader title={`Podobné záujmy · ${kindred.length}`} />
          <Caption style={styles.hint}>Chodíte na to isté, aj keď sa ešte nepoznáte.</Caption>
          {kindred.map((match) => <MatchRow key={match.user_id} match={match} />)}
        </>
      ) : null}

      <Caption style={styles.footnote}>
        Vidíš len ľudí, ktorí sa na event prihlásili verejne. Kto nechce byť v tomto
        zozname, vypne si to v Nastavenia → Súkromie.
      </Caption>
    </Screen>
  );
}

function MatchRow({ match }: { match: PeopleMatch }) {
  return (
    <Pressable
      style={styles.row}
      onPress={() => router.push(profileHref({ id: match.user_id, username: match.username }))}
    >
      <Avatar url={match.avatar_url} name={match.display_name} size={46} />
      <View style={styles.flex}>
        <Text style={styles.name}>{match.display_name ?? match.username}</Text>
        <Caption style={styles.reason}>{describeMatch(match)}</Caption>
      </View>
      <Badge tone="accent" label={`${Math.round(match.score * 100)}%`} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text },
  intro: { marginTop: spacing.xs, marginBottom: spacing.lg },
  hint: { marginBottom: spacing.sm },
  flex: { flex: 1, minWidth: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
  },
  name: { ...typography.bodyStrong, color: colors.text },
  reason: { color: colors.cyan },
  footnote: { marginTop: spacing.lg },
});
