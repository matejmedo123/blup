import React from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import { getFollowCounts, getInterestsFor } from '@/api/profiles';
import { getMyEvents, getSavedEvents, getAttendingEvents } from '@/api/events';
import { getMyTickets } from '@/api/tickets';
import { getMyOrganizations } from '@/api/organizations';
import { getPremiumStatus } from '@/api/premium';
import { env } from '@/lib/env';
import { formatCount } from '@/lib/format';
import { EventCard } from '@/components/EventCard';
import { toFeedItem } from '@/api/events';
import {
  Avatar, Badge, Body, Button, Caption, Chip, Divider, LoadingState, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

export default function ProfileScreen() {
  const { profile, isAdmin, signOut, refreshProfile, loadingProfile } = useAuth();

  const counts = useQuery({
    queryKey: ['profile', 'counts', profile?.id],
    queryFn: () => getFollowCounts(profile!.id),
    enabled: Boolean(profile?.id),
  });

  const interests = useQuery({
    queryKey: ['profile', 'interests', profile?.id],
    queryFn: () => getInterestsFor(profile!.id),
    enabled: Boolean(profile?.id),
  });

  const myEvents = useQuery({ queryKey: ['events', 'mine'], queryFn: getMyEvents });
  const saved = useQuery({ queryKey: ['events', 'saved'], queryFn: getSavedEvents });
  const attending = useQuery({ queryKey: ['events', 'attending'], queryFn: getAttendingEvents });
  const tickets = useQuery({ queryKey: ['tickets', 'mine'], queryFn: getMyTickets });
  const organizations = useQuery({ queryKey: ['organizations', 'mine'], queryFn: getMyOrganizations });
  const premium = useQuery({ queryKey: ['premium', 'status'], queryFn: getPremiumStatus });

  if (loadingProfile && !profile) {
    return <Screen><LoadingState /></Screen>;
  }

  const validTickets = (tickets.data ?? []).filter((ticket) => ticket.status === 'valid');

  return (
    <Screen
      scroll
      refreshControl={
        <RefreshControl
          refreshing={false}
          onRefresh={() => {
            void refreshProfile();
            void myEvents.refetch();
            void saved.refetch();
            void tickets.refetch();
          }}
          tintColor={colors.accent}
        />
      }
    >
      {/* --- header --------------------------------------------------------- */}
      <View style={styles.header}>
        <Avatar url={profile?.avatar_url} name={profile?.display_name} size={80} />

        <View style={styles.headerBody}>
          <View style={styles.nameRow}>
            <Text style={styles.name}>{profile?.display_name ?? 'Your profile'}</Text>
            {premium.data?.is_premium ? <Badge tone="accent" label="PREMIUM" /> : null}
          </View>
          <Caption>@{profile?.username ?? '—'}</Caption>

          <View style={styles.stats}>
            <Pressable style={styles.stat}>
              <Text style={styles.statValue}>{formatCount(counts.data?.followers ?? 0)}</Text>
              <Caption>followers</Caption>
            </Pressable>
            <Pressable style={styles.stat}>
              <Text style={styles.statValue}>{formatCount(counts.data?.following ?? 0)}</Text>
              <Caption>following</Caption>
            </Pressable>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{formatCount(myEvents.data?.length ?? 0)}</Text>
              <Caption>events</Caption>
            </View>
          </View>
        </View>
      </View>

      {profile?.bio ? <Body style={styles.bio}>{profile.bio}</Body> : null}

      <View style={styles.actions}>
        <Button
          title="Edit profile"
          variant="secondary"
          compact
          onPress={() => router.push('/settings/profile')}
          style={styles.flex}
        />
        <Button
          title="Settings"
          variant="secondary"
          compact
          onPress={() => router.push('/settings')}
          style={styles.flex}
        />
      </View>

      {/* --- interests ------------------------------------------------------ */}
      {(interests.data ?? []).length > 0 ? (
        <>
          <SectionHeader title="Interests" action="Edit" onAction={() => router.push('/settings/interests')} />
          <View style={styles.chips}>
            {(interests.data ?? []).map((interest) => (
              <Chip key={interest.id} label={`${interest.emoji ?? ''} ${interest.name}`.trim()} />
            ))}
          </View>
        </>
      ) : (
        <Button
          title="Pick your interests"
          variant="secondary"
          onPress={() => router.push('/settings/interests')}
          style={styles.pickInterests}
        />
      )}

      {/* --- quick links ---------------------------------------------------- */}
      <SectionHeader title="Your BLUP" />
      <View style={styles.links}>
        <LinkRow
          emoji="🎟️"
          label="My tickets"
          detail={validTickets.length > 0 ? `${validTickets.length} valid` : 'None yet'}
          onPress={() => router.push('/tickets')}
        />
        <LinkRow
          emoji="⭐"
          label="Saved events"
          detail={`${saved.data?.length ?? 0}`}
          onPress={() => router.push('/settings/saved')}
        />
        <LinkRow
          emoji="📅"
          label="Going to"
          detail={`${attending.data?.length ?? 0}`}
          onPress={() => router.push('/settings/attending')}
        />
        <LinkRow
          emoji="✨"
          label={premium.data?.is_premium ? 'Premium active' : 'Get BLUP Premium'}
          detail={premium.data?.is_premium ? (premium.data.status ?? '') : 'Upgrade'}
          onPress={() => router.push('/premium')}
        />
        <LinkRow
          emoji="🏢"
          label={organizations.data?.length ? 'Organizer dashboard' : 'Become an organizer'}
          detail={organizations.data?.length ? `${organizations.data.length}` : 'Sell tickets'}
          onPress={() => router.push(organizations.data?.length ? '/organizer' : '/organizer/new')}
        />
        {isAdmin ? (
          <LinkRow emoji="🛡️" label="Admin" detail="Moderation" onPress={() => router.push('/admin')} />
        ) : null}
        {env.debugAi ? (
          <LinkRow emoji="🧪" label="AI debug" detail="Why this?" onPress={() => router.push('/debug/ai')} />
        ) : null}
      </View>

      {/* --- my events ------------------------------------------------------ */}
      <SectionHeader title="Events you created" />
      {(myEvents.data ?? []).length === 0 ? (
        <Body muted style={styles.emptyLine}>
          You have not created anything yet. Your first BLUP shows up here.
        </Body>
      ) : (
        (myEvents.data ?? []).slice(0, 5).map((event) => (
          <View key={event.id} style={styles.eventItem}>
            <EventCard
              event={toFeedItem(event)}
              onPress={() => router.push(`/event/${event.id}`)}
            />
          </View>
        ))
      )}

      <Divider />

      <Button title="Sign out" variant="danger" onPress={() => void signOut()} />
    </Screen>
  );
}

function LinkRow({
  emoji, label, detail, onPress,
}: {
  emoji: string;
  label: string;
  detail?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.linkRow, pressed && styles.linkRowPressed]}
    >
      <Text style={styles.linkEmoji}>{emoji}</Text>
      <Text style={styles.linkLabel}>{label}</Text>
      <View style={styles.flex} />
      {detail ? <Caption>{detail}</Caption> : null}
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },

  header: { flexDirection: 'row', gap: spacing.lg, alignItems: 'center' },
  headerBody: { flex: 1, gap: 2 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { ...typography.heading, color: colors.text },

  stats: { flexDirection: 'row', gap: spacing.xl, marginTop: spacing.md },
  stat: { alignItems: 'center' },
  statValue: { ...typography.subheading, color: colors.text },

  bio: { marginTop: spacing.lg },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pickInterests: { marginTop: spacing.lg },

  links: { gap: 2 },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  linkRowPressed: { backgroundColor: colors.surfacePressed },
  linkEmoji: { fontSize: 18 },
  linkLabel: { ...typography.body, color: colors.text },
  chevron: { ...typography.heading, color: colors.textTertiary },

  emptyLine: { marginBottom: spacing.lg },
  eventItem: { marginBottom: spacing.lg },
});
