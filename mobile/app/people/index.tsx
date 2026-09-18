import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { describeMatch, dismissPerson, getPeopleRecommendations } from '@/api/ai';
import { getPostEventMatches, describeOverlap, type PostEventMatch } from '@/api/networking';
import {
  followUser, getFollowing, searchProfiles, unfollowUser,
} from '@/api/profiles';
import { useAuth } from '@/auth/AuthProvider';
import { messageFor } from '@/lib/errors';
import { formatRelative } from '@/lib/format';
import { useToast } from '@/components/Toast';
import { Avatar, ErrorState, IconButton, Input, LoadingState, Notice } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';
import type { PeopleMatch, Profile } from '@/types/models';

/**
 * Ľudia.
 *
 * People used to live at the top of Komunita, above the interest communities.
 * They are not the same thing and never were: a community is something you join
 * and it has a feed; a person is somebody you follow and might stand next to at
 * a gig. Putting them on one screen meant the people were always the bit you
 * scrolled past to get to the communities, and the whole point of BLUP is that
 * you go out and meet somebody.
 *
 * So they get their own screen — find, suggested, and the ones you were
 * actually in a room with — and Komunita is now about communities.
 */
export default function PeopleScreen() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { isGuest, user } = useAuth();

  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [debounced, setDebounced] = React.useState('');

  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const searching = debounced.length >= 2;

  const found = useQuery({
    queryKey: ['people', 'search', debounced],
    queryFn: () => searchProfiles(debounced, 30),
    enabled: searching,
  });

  const people = useQuery({
    queryKey: ['people', 'recommendations'],
    queryFn: () => getPeopleRecommendations({ limit: 20 }),
    enabled: !isGuest,
  });

  const networking = useQuery({
    queryKey: ['people', 'post-event'],
    queryFn: () => getPostEventMatches({ limit: 12 }),
    enabled: !isGuest,
  });

  const following = useQuery({
    queryKey: ['following', user?.id],
    queryFn: () => getFollowing(user!.id),
    enabled: Boolean(user?.id),
  });

  const followingIds = React.useMemo(
    () => new Set((following.data ?? []).map((profile) => profile.id)),
    [following.data],
  );

  const toggleFollow = async (userId: string, isFollowing: boolean) => {
    setError(null);
    try {
      if (isFollowing) {
        await unfollowUser(userId);
      } else {
        await followUser(userId);
        toast.show('Sleduješ');
      }
      await queryClient.invalidateQueries({ queryKey: ['following'] });
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  // "Not for me" is what makes a suggestion list bearable: without it the same
  // wrong person is at the top of the screen every single time you open it.
  const dismiss = async (userId: string) => {
    setError(null);
    try {
      await dismissPerson(userId);
      await queryClient.invalidateQueries({ queryKey: ['people', 'recommendations'] });
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  const loading = !searching && people.isLoading && networking.isLoading;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <IconButton glyph="‹" size={40} onPress={() => router.back()} />
        <Text style={styles.screenTitle}>Ľudia</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {error ? <Notice tone="danger" title="Niečo sa pokazilo" body={error} /> : null}

        <Input
          value={search}
          onChangeText={setSearch}
          placeholder="Nájdi človeka — meno alebo @prezývka"
          autoCapitalize="none"
          style={styles.search}
        />

        {searching ? (
          <>
            <Text style={styles.section}>Nájdené</Text>
            {found.isLoading ? (
              <LoadingState />
            ) : (found.data ?? []).length === 0 ? (
              <EmptyBlock text={`Na „${debounced}" sme nikoho nenašli.`} />
            ) : (
              (found.data ?? []).map((profile) => (
                <FoundRow
                  key={profile.id}
                  profile={profile}
                  isFollowing={followingIds.has(profile.id)}
                  onToggle={() => toggleFollow(profile.id, followingIds.has(profile.id))}
                />
              ))
            )}
          </>
        ) : loading ? (
          <LoadingState />
        ) : people.isError && networking.isError ? (
          <ErrorState
            message={messageFor(people.error ?? networking.error)}
            onRetry={() => {
              void people.refetch();
              void networking.refetch();
            }}
          />
        ) : (
          <>
            {/* --- people like you ------------------------------------------ */}
            <Text style={styles.section}>Ľudia ako ty</Text>
            <Text style={styles.sectionHint}>
              Spoločné záujmy, eventy, na ktorých ste boli obaja, a ľudia, ktorých
              obaja sledujete.
            </Text>

            {(people.data ?? []).length === 0 ? (
              <EmptyBlock
                text="Vyber si viac záujmov a označ pár eventov — potom ti sem nájdeme ľudí."
                actionLabel="Nastaviť záujmy"
                onAction={() => router.push('/settings/interests')}
              />
            ) : (
              (people.data ?? []).map((match) => (
                <PersonRow
                  key={match.user_id}
                  match={match}
                  isFollowing={followingIds.has(match.user_id)}
                  onToggle={() => toggleFollow(match.user_id, followingIds.has(match.user_id))}
                  onDismiss={() => dismiss(match.user_id)}
                />
              ))
            )}

            {/* --- post-event ------------------------------------------------ */}
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

            {/* --- who you follow -------------------------------------------- */}
            {(following.data ?? []).length > 0 ? (
              <>
                <Text style={styles.section}>Koho sleduješ</Text>
                {(following.data ?? []).map((profile) => (
                  <FoundRow
                    key={profile.id}
                    profile={profile}
                    isFollowing
                    onToggle={() => toggleFollow(profile.id, true)}
                  />
                ))}
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function PersonRow({
  match, isFollowing, onToggle, onDismiss,
}: {
  match: PeopleMatch;
  isFollowing: boolean;
  onToggle: () => void;
  onDismiss: () => void;
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

      <View style={styles.rowActions}>
        <Pressable
          onPress={onToggle}
          style={[styles.followButton, isFollowing && styles.followButtonActive]}
        >
          <Text style={[styles.followLabel, isFollowing && styles.followLabelActive]}>
            {isFollowing ? 'Sledujem' : 'Sledovať'}
          </Text>
        </Pressable>
        <Pressable onPress={onDismiss} hitSlop={8}>
          <Text style={styles.dismiss}>Nezaujíma ma</Text>
        </Pressable>
      </View>
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

function FoundRow({
  profile, isFollowing, onToggle,
}: {
  profile: Profile;
  isFollowing: boolean;
  onToggle: () => void;
}) {
  return (
    <View style={styles.row}>
      <Pressable onPress={() => router.push(`/user/${profile.id}`)}>
        <Avatar url={profile.avatar_url} name={profile.display_name} size={46} square />
      </Pressable>

      <Pressable style={styles.flex} onPress={() => router.push(`/user/${profile.id}`)}>
        <Text style={styles.rowName} numberOfLines={1}>
          {profile.display_name ?? profile.username}
        </Text>
        {profile.username ? (
          <Text style={styles.rowTags} numberOfLines={1}>@{profile.username}</Text>
        ) : null}
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
  flex: { flex: 1, minWidth: 0 },
  search: { marginBottom: spacing.md },

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
  section: {
    ...typography.heading,
    color: colors.text,
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
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
  rowActions: { alignItems: 'flex-end', gap: 6 },

  followButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: radius.chip,
    backgroundColor: colors.accent,
  },
  followButtonActive: { backgroundColor: colors.surfaceElevated2 },
  followLabel: { ...typography.chip, color: '#FFFFFF' },
  followLabelActive: { color: colors.textSecondary },
  dismiss: { ...typography.metaSm, color: colors.textQuaternary },

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
});
