import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getCommunities, getMyCommunities, joinCommunity, leaveCommunity, type Community,
} from '@/api/communities';
import { messageFor } from '@/lib/errors';
import { formatCount } from '@/lib/format';
import { useToast } from '@/components/Toast';
import { ErrorState, IconButton, Input, LoadingState, Notice } from '@/components/ui';
import {
  categoryFamilies, colors, familyFor, labelFor, radius, spacing, typography,
} from '@/theme';

/**
 * Komunita.
 *
 * Communities, and only communities: browse them, search them, found one, and
 * see what the ones you are in are putting on.
 *
 * People used to be here too — "Ľudia ako ty" sat above the communities and
 * post-event matches below them. They have moved to /people, because a person
 * is not a community: you join a community and it has a feed, you follow a
 * person and you might end up standing next to them. On one screen the people
 * were permanently the part you scrolled past.
 */
export default function CommunityScreen() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [debounced, setDebounced] = React.useState('');

  // A list of every community is only browsable while there are few of them.
  // Debounced rather than per keystroke, so typing "techno" is one query.
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const searching = debounced.length >= 2;

  const communities = useQuery({
    queryKey: ['communities', 'browse', debounced],
    // A wider net while searching: eight is a taste of what exists, but a
    // search is a question, and cutting the answer at eight hides matches.
    queryFn: () => getCommunities(searching ? { query: debounced, limit: 40 } : { limit: 8 }),
  });

  const mine = useQuery({ queryKey: ['communities', 'mine'], queryFn: getMyCommunities });

  const joinedIds = new Set((mine.data ?? []).map((community) => community.id));

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

  if (communities.isLoading) {
    return <SafeAreaView style={styles.screen} edges={['top']}><LoadingState /></SafeAreaView>;
  }

  if (communities.isError) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <ErrorState
          message={messageFor(communities.error)}
          onRetry={() => { void communities.refetch(); }}
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

        {/* People live on their own screen now. This is a door to it, not a
            second copy of it — two lists of the same people that drift apart
            is worse than one. */}
        <Pressable style={styles.peopleLink} onPress={() => router.push('/people')}>
          <View style={styles.flex}>
            <Text style={styles.peopleLinkTitle}>Ľudia ako ty</Text>
            <Text style={styles.peopleLinkBody}>
              Spoločné záujmy, spoločné eventy — a ľudia, s ktorými si už na
              nejakom bol.
            </Text>
          </View>
          <Text style={styles.peopleLinkArrow}>→</Text>
        </Pressable>

        {/* --- interest communities ------------------------------------------ */}
        <Text style={styles.section}>Záujmové komunity</Text>

        <Input
          value={search}
          onChangeText={setSearch}
          placeholder="Hľadaj komunitu — techno, behanie, startupy…"
          autoCapitalize="none"
          style={styles.communitySearch}
        />

        {(communities.data ?? []).length === 0 ? (
          searching ? (
            <EmptyBlock
              text={`Na „${debounced}" sme nič nenašli. Skús iné slovo — alebo takú komunitu založ.`}
              actionLabel="Založiť komunitu"
              onAction={() => router.push('/community/new')}
            />
          ) : (
            <EmptyBlock
              text="Zatiaľ tu žiadne nie sú. Založ prvú — tematickú skupinu s vlastným feedom."
              actionLabel="Založiť komunitu"
              onAction={() => router.push('/community/new')}
            />
          )
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
            <Text style={styles.bannerTitle}>Čo chystajú tvoje komunity</Text>
            {/* The old copy promised "do 20 ľudí, bez vstupenky". Nothing
                anywhere enforces either — a community event is an ordinary
                event whose host happens to be a community. */}
            <Text style={styles.bannerBody}>
              Workshopy, meetupy a tréningy od komunít, v ktorých si.
            </Text>
            <Text style={styles.bannerCta}>Pozrieť →</Text>
          </LinearGradient>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
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
  communitySearch: { marginBottom: spacing.md },
  screen: { flex: 1, backgroundColor: colors.background },
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
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

  peopleLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: spacing.lg,
  },
  peopleLinkTitle: { ...typography.rowTitle, color: colors.text },
  peopleLinkBody: { ...typography.metaSm, color: colors.textTertiary, marginTop: 3 },
  peopleLinkArrow: { ...typography.rowTitle, color: colors.accent },

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
