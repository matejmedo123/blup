import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { eventHref } from '@/lib/format';
import { useAuth } from '@/auth/AuthProvider';
import {
  followUser, getEventsByCreator, getFollowCounts, getInterestsFor, getProfile, isFollowing,
  unfollowUser,
} from '@/api/profiles';
import { reportContent } from '@/api/admin';
import { startDirectConversation } from '@/api/messages';
import { getGamification, levelTitle } from '@/api/gamification';
import { messageFor } from '@/lib/errors';
import { formatCount } from '@/lib/format';
import { EventCard } from '@/components/EventCard';
import {
  Avatar, Badge, Body, Button, Caption, Chip, EmptyState, ErrorState, LoadingState, Notice,
  Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

export default function UserProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile: me } = useAuth();
  const queryClient = useQueryClient();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const profile = useQuery({
    queryKey: ['profile', id],
    queryFn: () => getProfile(id!),
    enabled: Boolean(id),
  });

  // Whatever the link used, the address people copy from here is the handle.
  // Twelve call sites hold only a uuid and have no username to hand; rewriting
  // it once, here, makes every share from this screen a readable link without
  // chasing all of them.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handle = profile.data?.username;
    if (!handle || id?.startsWith('@')) return;
    window.history.replaceState(null, '', `/user/@${handle}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.data?.username]);

  const counts = useQuery({
    queryKey: ['profile', 'counts', id],
    queryFn: () => getFollowCounts(id!),
    enabled: Boolean(id),
  });

  const following = useQuery({
    queryKey: ['profile', 'is-following', id],
    queryFn: () => isFollowing(id!),
    enabled: Boolean(id) && id !== me?.id,
  });

  const interests = useQuery({
    queryKey: ['profile', 'interests', id],
    queryFn: () => getInterestsFor(id!),
    enabled: Boolean(id),
  });

  const game = useQuery({
    queryKey: ['gamification', id],
    queryFn: () => getGamification(id!),
    enabled: Boolean(id),
    retry: false,
  });

  const events = useQuery({
    queryKey: ['profile', 'events', id],
    queryFn: () => getEventsByCreator(id!),
    enabled: Boolean(id),
  });

  const toggleFollow = async () => {
    setError(null);
    setBusy(true);
    try {
      if (following.data) await unfollowUser(id!);
      else await followUser(id!);

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['profile', 'is-following', id] }),
        queryClient.invalidateQueries({ queryKey: ['profile', 'counts', id] }),
      ]);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const message = async () => {
    setError(null);
    setBusy(true);
    try {
      const conversationId = await startDirectConversation(id!);
      router.push(`/chat/${conversationId}`);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const report = async () => {
    try {
      await reportContent({ targetType: 'user', targetId: id!, reason: 'Nahlásené z profilu' });
      setNotice('Nahlásené. Naši moderátori sa na to pozrú.');
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  if (profile.isLoading) return <Screen><LoadingState /></Screen>;

  if (profile.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(profile.error)} onRetry={() => void profile.refetch()} />
      </Screen>
    );
  }

  if (!profile.data) {
    return (
      <Screen>
        <EmptyState
          emoji="🔒"
          title="Profil nie je dostupný"
          body="Tento účet je súkromný, pozastavený alebo už neexistuje."
        />
      </Screen>
    );
  }

  const person = profile.data;
  const isMe = person.id === me?.id;

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Toto sa nepodarilo" body={error} /> : null}
      {notice ? <Notice tone="accent" title="Ďakujeme" body={notice} /> : null}

      <View style={styles.header}>
        <Avatar url={person.avatar_url} name={person.display_name} size={84} />

        <View style={styles.headerBody}>
          <Text style={styles.name}>{person.display_name ?? person.username}</Text>
          <Caption>@{person.username}</Caption>
          {person.city ? <Caption>{person.city}</Caption> : null}

          {game.data ? (
            <View style={styles.levelRow}>
              <View style={styles.levelPill}>
                <Text style={styles.levelPillText}>LVL {game.data.level}</Text>
              </View>
              <Caption>{levelTitle(game.data.level)}</Caption>
              {(game.data.badges ?? []).slice(0, 4).map((badge) => (
                <Text key={badge.slug} style={styles.badgeEmoji}>{badge.emoji}</Text>
              ))}
            </View>
          ) : null}

          <View style={styles.stats}>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{formatCount(counts.data?.followers ?? 0)}</Text>
              <Caption>sledujú</Caption>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{formatCount(counts.data?.following ?? 0)}</Text>
              <Caption>sleduje</Caption>
            </View>
          </View>
        </View>
      </View>

      {person.bio ? <Body style={styles.bio}>{person.bio}</Body> : null}

      {!isMe ? (
        <View style={styles.actions}>
          <Button
            title={following.data ? 'Sledujem' : 'Sledovať'}
            variant={following.data ? 'secondary' : 'primary'}
            onPress={toggleFollow}
            loading={busy}
            style={styles.flex}
          />
          <Button
            title="Napísať"
            variant="teal"
            onPress={message}
            disabled={busy}
            style={styles.flex}
          />
        </View>
      ) : (
        <Button
          title="Upraviť profil"
          variant="secondary"
          onPress={() => router.push('/settings/profile')}
          style={styles.actions}
        />
      )}

      {(interests.data ?? []).length > 0 ? (
        <>
          <SectionHeader title="Záujmy" />
          <View style={styles.chips}>
            {(interests.data ?? []).map((interest) => (
              <Chip key={interest.id} label={`${interest.emoji ?? ''} ${interest.name}`.trim()} />
            ))}
          </View>
        </>
      ) : null}

      <SectionHeader title="Eventy" />
      {(events.data ?? []).length === 0 ? (
        <Body muted>Zatiaľ nič verejné.</Body>
      ) : (
        (events.data ?? []).map((event) => (
          <View key={event.id} style={styles.eventItem}>
            <EventCard event={event} onPress={() => router.push(eventHref(event))} />
          </View>
        ))
      )}

      {!isMe ? (
        <Button title="Nahlásiť profil" variant="ghost" onPress={report} style={styles.report} />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
  header: { flexDirection: 'row', gap: spacing.lg, alignItems: 'center' },
  headerBody: { flex: 1, gap: 2 },
  name: { ...typography.heading, color: colors.text },
  stats: { flexDirection: 'row', gap: spacing.xl, marginTop: spacing.md },
  stat: { alignItems: 'center' },
  statValue: { ...typography.subheading, color: colors.text },

  bio: { marginTop: spacing.lg },
  levelRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs },
  levelPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
  },
  levelPillText: { ...typography.mono, color: colors.accentText },
  badgeEmoji: { fontSize: 14 },

  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  eventItem: { marginBottom: spacing.lg },
  report: { marginTop: spacing.xl },
});
