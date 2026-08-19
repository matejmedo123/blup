import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getPeopleRecommendations, describeMatch } from '@/api/ai';
import { getPostEventMatches, describeOverlap, type PostEventMatch } from '@/api/networking';
import {
  getCommunities, getMyCommunities, joinCommunity, leaveCommunity, type Community,
} from '@/api/communities';
import { followUser, unfollowUser, getFollowing } from '@/api/profiles';
import { messageFor } from '@/lib/errors';
import { formatCount, formatRelative } from '@/lib/format';
import { useToast } from '@/components/Toast';
import { Avatar, ErrorState, IconButton, LoadingState, Notice } from '@/components/ui';
import {
  categoryFamilies, colors, familyFor, labelFor, radius, spacing, typography,
} from '@/theme';
import type { PeopleMatch } from '@/types/models';

/**
 * Komunita.
 *
 * Four blocks, in the handoff's order: people like you, interest communities,
 * post-event networking, and micro-communities. The first two are ranked by the
 * database; the third is built from who you actually stood next to.
 */
export default function CommunityScreen() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [error, setError] = React.useState<string | null>(null);

  const people = useQuery({
    queryKey: ['people', 'recommendations'],
    queryFn: () => getPeopleRecommendations({ limit: 8 }),
  });

  const communities = useQuery({
    queryKey: ['communities', 'browse'],
    queryFn: () => getCommunities({ limit: 8 }),
  });

  const mine = useQuery({ queryKey: ['communities', 'mine'], queryFn: getMyCommunities });

  const networking = useQuery({
    queryKey: ['networking', 'post-event'],
    queryFn: () => getPostEventMatches({ days: 60, limit: 8 }),
  });

  const following = useQuery({
    queryKey: ['profile', 'following', 'ids'],
    queryFn: async () => {
      const { data } = await import('@/lib/supabase').then((m) => m.supabase.auth.getUser());
      const id = data?.user?.id;
      if (!id) return [] as string[];
      const list = await getFollowing(id);
      return list.map((person) => person.id);
    },
  });

  const followingIds = new Set(following.data ?? []);
  const joinedIds = new Set((mine.data ?? []).map((community) => community.id));

  const toggleFollow = async (userId: string, isFollowing: boolean) => {
    setError(null);
    try {
      if (isFollowing) {
        await unfollowUser(userId);
        toast.show('Už ho nesleduješ');
      } else {
        await followUser(userId);
        toast.show('Sleduješ');
      }
      await queryClient.invalidateQueries({ queryKey: ['profile', 'following'] });
      await networking.refetch();
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  const toggleJoin = async (communityId: string, joined: boolean) => {
    setError(null);
    try {
      if (joined) {
        await leaveCommunity(communityId);
        toast.show('Opustil si komunitu');
      } else {
        await joinCommunity(communityId);
        toast.show('Si v komunite');
      }
      await queryClient.invalidateQueries({ queryKey: ['communities'] });
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  if (people.isLoading && communities.isLoading) {
    return <SafeAreaView style={styles.screen} edges={['top']}><LoadingState /></SafeAreaView>;
  }

  if (people.isError && communities.isError) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <ErrorState
          message={messageFor(people.error ?? communities.error)}
          onRetry={() => {
            void people.refetch();
            void communities.refetch();
          }}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <IconButton glyph="‹" size={40} onPress={() => router.back()} />
        <Text style={styles.screenTitle}>Komunita</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {error ? <Notice tone="danger" title="Niečo sa pokazilo" body={error} /> : null}

        {/* --- people like you ---------------------------------------------- */}
        <Text style={styles.section}>Ľudia ako ty</Text>

        {(people.data ?? []).length === 0 ? (
          <EmptyBlock text="Vyber si viac záujmov a označ pár eventov — potom ti sem nájdeme ľudí." />
        ) : (
          (people.data ?? []).map((match) => (
            <PersonRow
              key={match.user_id}
              match={match}
              isFollowing={followingIds.has(match.user_id)}
              onToggle={() => toggleFollow(match.user_id, followingIds.has(match.user_id))}
            />
          ))
        )}

        {/* --- interest communities ------------------------------------------ */}
        <Text style={styles.section}>Záujmové komunity</Text>

        {(communities.data ?? []).length === 0 ? (
          <EmptyBlock
            text="Zatiaľ tu žiadne nie sú. Založ prvú — tematickú skupinu s vlastným feedom."
            actionLabel="Založiť komunitu"
            onAction={() => router.push('/community/new')}
          />
        ) : (
          (communities.data ?? []).map((community) => (
            <CommunityRow
              key={community.id}
              community={community}
              joined={joinedIds.has(community.id)}
              onOpen={() => router.push(`/community/${community.id}`)}
              onToggle={() => toggleJoin(community.id, joinedIds.has(community.id))}
            />
          ))
        )}

        <Pressable style={styles.newRow} onPress={() => router.push('/community/new')}>
          <Text style={styles.newGlyph}>＋</Text>
          <Text style={styles.newLabel}>Založiť vlastnú komunitu</Text>
        </Pressable>

        {/* --- post-event networking ----------------------------------------- */}
        <Text style={styles.section}>Po evente</Text>

        {(networking.data ?? []).length === 0 ? (
          <EmptyBlock text="Choď na event a potom sem doplníme ľudí, s ktorými si tam bol." />
        ) : (
          <>
            <Text style={styles.sectionHint}>
              Boli ste na tom istom mieste. Ešte sa nesledujete.
            </Text>
            {(networking.data ?? []).map((match) => (
              <NetworkingRow
                key={match.user_id}
                match={match}
                onFollow={() => toggleFollow(match.user_id, false)}
              />
            ))}
          </>
        )}

        {/* --- micro-communities ---------------------------------------------- */}
        <Pressable
          onPress={() => router.push('/community/micro')}
          style={({ pressed }) => [pressed && styles.pressed]}
        >
          <LinearGradient
            colors={[colors.purple, colors.pink]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0.6 }}
            style={styles.banner}
          >
            <Text style={styles.bannerTitle}>Micro-eventy</Text>
            <Text style={styles.bannerBody}>
              Malé workshopy a meetupy vnútri komunít — do 20 ľudí, bez vstupenky.
            </Text>
            <Text style={styles.bannerCta}>Pozrieť →</Text>
          </LinearGradient>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function PersonRow({
  match, isFollowing, onToggle,
}: {
  match: PeopleMatch;
  isFollowing: boolean;
  onToggle: () => void;
}) {
  return (
    <View style={styles.row}>
      <Pressable onPress={() => router.push(`/user/${match.user_id}`)}>
        <Avatar url={match.avatar_url} name={match.display_name} size={46} square />
      </Pressable>

      <Pressable style={styles.flex} onPress={() => router.push(`/user/${match.user_id}`)}>
        <Text style={styles.rowName} numberOfLines={1}>
          {match.display_name ?? match.username}
        </Text>
        {match.shared_interest_names.length > 0 ? (
          <Text style={styles.rowTags} numberOfLines={1}>
            {match.shared_interest_names.slice(0, 3).join(' · ')}
          </Text>
        ) : null}
        <Text style={styles.rowReason} numberOfLines={1}>{describeMatch(match)}</Text>
      </Pressable>

      <Pressable
        onPress={onToggle}
        style={[styles.followButton, isFollowing && styles.followButtonActive]}
      >
        <Text style={[styles.followLabel, isFollowing && styles.followLabelActive]}>
          {isFollowing ? 'Sledujem' : 'Sledovať'}
        </Text>
      </Pressable>
    </View>
  );
}

function NetworkingRow({ match, onFollow }: { match: PostEventMatch; onFollow: () => void }) {
  return (
    <View style={styles.row}>
      <Pressable onPress={() => router.push(`/user/${match.user_id}`)}>
        <Avatar url={match.avatar_url} name={match.display_name} size={46} square />
      </Pressable>

      <Pressable style={styles.flex} onPress={() => router.push(`/user/${match.user_id}`)}>
        <Text style={styles.rowName} numberOfLines={1}>
          {match.display_name ?? match.username}
        </Text>
        <Text style={styles.rowReason} numberOfLines={2}>{describeOverlap(match)}</Text>
        {match.last_event_at ? (
          <Text style={styles.rowWhen}>{formatRelative(match.last_event_at)}</Text>
        ) : null}
      </Pressable>

      <Pressable onPress={onFollow} style={styles.followButton}>
        <Text style={styles.followLabel}>Spojiť sa</Text>
      </Pressable>
    </View>
  );
}

function CommunityRow({
  community, joined, onOpen, onToggle,
}: {
  community: Community;
  joined: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const family = categoryFamilies[familyFor(community.category)];

  return (
    <View style={styles.row}>
      <Pressable onPress={onOpen}>
        <LinearGradient
          colors={[...family.gradient]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.communityIcon}
        >
          <Text style={styles.communityGlyph}>{family.glyph}</Text>
        </LinearGradient>
      </Pressable>

      <Pressable style={styles.flex} onPress={onOpen}>
        <Text style={styles.rowName} numberOfLines={1}>{community.name}</Text>
        <Text style={styles.rowTags} numberOfLines={1}>
          {labelFor(community.category)}
          {community.city ? ` · ${community.city}` : ''}
        </Text>
        <Text style={styles.rowReason}>
          {formatCount(community.member_count)} {community.member_count === 1 ? 'člen' : 'členov'}
        </Text>
      </Pressable>

      <Pressable
        onPress={onToggle}
        style={[styles.followButton, joined && styles.followButtonActive]}
      >
        <Text style={[styles.followLabel, joined && styles.followLabelActive]}>
          {joined ? 'Člen' : 'Pridať sa'}
        </Text>
      </Pressable>
    </View>
  );
}

function EmptyBlock({
  text, actionLabel, onAction,
}: {
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyText}>{text}</Text>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction}>
          <Text style={styles.emptyAction}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  pressed: { opacity: 0.9 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
  },
  screenTitle: { ...typography.screenTitle, color: colors.text },

  content: { paddingHorizontal: spacing.gutter, paddingBottom: spacing.xxxl },
  section: { ...typography.heading, color: colors.text, marginTop: spacing.xl, marginBottom: spacing.md },
  sectionHint: { ...typography.metaSm, color: colors.textTertiary, marginBottom: spacing.md },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  rowName: { ...typography.rowTitle, color: colors.text },
  rowTags: { ...typography.metaSm, color: colors.textTertiary, marginTop: 2 },
  rowReason: { ...typography.metaSm, color: colors.cyan, marginTop: 3 },
  rowWhen: { ...typography.monoSm, color: colors.textMuted, marginTop: 3 },

  communityIcon: {
    width: 46,
    height: 46,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  communityGlyph: { fontSize: 19, color: '#FFFFFF' },

  followButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: radius.chip,
    backgroundColor: colors.accent,
  },
  followButtonActive: { backgroundColor: colors.surfaceElevated2 },
  followLabel: { ...typography.chip, color: '#FFFFFF' },
  followLabelActive: { color: colors.textSecondary },

  newRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.card,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
  },
  newGlyph: { fontSize: 20, color: colors.accent },
  newLabel: { ...typography.rowTitle, color: colors.accent },

  empty: {
    padding: spacing.lg,
    borderRadius: radius.card,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  emptyText: { ...typography.body, color: colors.textTertiary },
  emptyAction: { ...typography.chip, color: colors.accent },

  banner: {
    borderRadius: radius.card,
    padding: spacing.xl,
    gap: spacing.sm,
    marginTop: spacing.xl,
  },
  bannerTitle: { ...typography.heading, color: '#FFFFFF' },
  bannerBody: { ...typography.body, color: 'rgba(255,255,255,0.88)' },
  bannerCta: { ...typography.chip, color: '#FFFFFF', marginTop: spacing.xs },
});
