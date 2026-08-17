import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import {
  followUser, getEventsByCreator, getFollowCounts, getInterestsFor, getProfile, isFollowing,
  unfollowUser,
} from '@/api/profiles';
import { reportContent } from '@/api/admin';
import { messageFor } from '@/lib/errors';
import { formatCount } from '@/lib/format';
import { EventCard } from '@/components/EventCard';
import {
  Avatar, Badge, Body, Button, Caption, Chip, EmptyState, ErrorState, LoadingState, Notice,
  Screen, SectionHeader,
} from '@/components/ui';
import { colors, spacing, typography } from '@/theme';

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

  const report = async () => {
    try {
      await reportContent({ targetType: 'user', targetId: id!, reason: 'Reported from profile' });
      setNotice('Reported. Our moderators will review it.');
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
          title="Profile not available"
          body="This account is private, suspended, or no longer exists."
        />
      </Screen>
    );
  }

  const person = profile.data;
  const isMe = person.id === me?.id;

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Could not do that" body={error} /> : null}
      {notice ? <Notice tone="accent" title="Thanks" body={notice} /> : null}

      <View style={styles.header}>
        <Avatar url={person.avatar_url} name={person.display_name} size={84} />

        <View style={styles.headerBody}>
          <Text style={styles.name}>{person.display_name ?? person.username}</Text>
          <Caption>@{person.username}</Caption>
          {person.city ? <Caption>{person.city}</Caption> : null}

          <View style={styles.stats}>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{formatCount(counts.data?.followers ?? 0)}</Text>
              <Caption>followers</Caption>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{formatCount(counts.data?.following ?? 0)}</Text>
              <Caption>following</Caption>
            </View>
          </View>
        </View>
      </View>

      {person.bio ? <Body style={styles.bio}>{person.bio}</Body> : null}

      {!isMe ? (
        <View style={styles.actions}>
          <Button
            title={following.data ? 'Following' : 'Follow'}
            variant={following.data ? 'secondary' : 'primary'}
            onPress={toggleFollow}
            loading={busy}
            style={styles.flex}
          />
        </View>
      ) : (
        <Button
          title="Edit your profile"
          variant="secondary"
          onPress={() => router.push('/settings/profile')}
          style={styles.actions}
        />
      )}

      {(interests.data ?? []).length > 0 ? (
        <>
          <SectionHeader title="Interests" />
          <View style={styles.chips}>
            {(interests.data ?? []).map((interest) => (
              <Chip key={interest.id} label={`${interest.emoji ?? ''} ${interest.name}`.trim()} />
            ))}
          </View>
        </>
      ) : null}

      <SectionHeader title="Events" />
      {(events.data ?? []).length === 0 ? (
        <Body muted>Nothing public yet.</Body>
      ) : (
        (events.data ?? []).map((event) => (
          <View key={event.id} style={styles.eventItem}>
            <EventCard event={event} onPress={() => router.push(`/event/${event.id}`)} />
          </View>
        ))
      )}

      {!isMe ? (
        <Button title="Report this profile" variant="ghost" onPress={report} style={styles.report} />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: 'row', gap: spacing.lg, alignItems: 'center' },
  headerBody: { flex: 1, gap: 2 },
  name: { ...typography.heading, color: colors.text },
  stats: { flexDirection: 'row', gap: spacing.xl, marginTop: spacing.md },
  stat: { alignItems: 'center' },
  statValue: { ...typography.subheading, color: colors.text },

  bio: { marginTop: spacing.lg },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  eventItem: { marginBottom: spacing.lg },
  report: { marginTop: spacing.xl },
});
