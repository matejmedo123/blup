import React, { useState } from 'react';
import { EventListSkeleton, DetailSkeleton } from '@/components/Skeleton';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import { useRequireAuth } from '@/auth/useRequireAuth';
import { getFeed, getFeedCounts, type FeedScope, togglePostLike, type CommunityPost } from '@/api/communities';
import { getFollowing } from '@/api/profiles';
import { pickImage, uploadCommunityImage } from '@/storage/uploads';
import { createPost } from '@/api/communities';
import { getMyOrganizations } from '@/api/organizations';
import { messageFor } from '@/lib/errors';
import { eventHref, formatCount, formatRelative } from '@/lib/format';
import { useToast } from '@/components/Toast';
import { BottomSheet } from '@/components/BottomSheet';
import {
  Avatar, Body, Button, Caption, Chip, EmptyState, ErrorState, Input, LoadingState, Notice,
  Screen,
} from '@/components/ui';
import { SiteFooter } from '@/components/SiteFooter';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import { avatarColorFor, colors, radius, spacing, typography } from '@/theme';

/**
 * Feed.
 *
 * Stories across the top (people you follow), then posts: author, the event the
 * post belongs to, the photo, the text, and the actions — like, "Idem tiež",
 * and the event's rating on the right.
 */
const SCOPES: { key: FeedScope; label: string }[] = [
  { key: 'following', label: 'Sledujem' },
  { key: 'for_you', label: 'Pre teba' },
  { key: 'all', label: 'Všetko' },
];

export default function FeedScreen() {
  const { requireAuth } = useRequireAuth();
  const { profile, isGuest } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [composerOpen, setComposerOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Whose name the post goes out under: null = mine, otherwise an organization. */
  const [postAs, setPostAs] = useState<string | null>(null);

  const [scope, setScope] = useState<FeedScope | null>(null);

  // How full each view is, so the first one shown has something in it. Opening
  // on an empty "Sledujem" and making somebody find the tab that works is a
  // worse first impression than showing them everything.
  const counts = useQuery({ queryKey: ['feed', 'counts'], queryFn: getFeedCounts });

  // An organizer writes to the feed as the name their events are sold under,
  // not as themselves. Only fetched for signed-in people — a guest has none.
  const organizations = useQuery({
    queryKey: ['organizations', 'mine'],
    queryFn: getMyOrganizations,
    enabled: !isGuest,
  });

  const activeScope: FeedScope = scope ?? (
    (counts.data?.following ?? 0) > 0 ? 'following'
      : (counts.data?.for_you ?? 0) > 0 ? 'for_you'
        : 'all'
  );

  const posts = useQuery({
    queryKey: ['feed', activeScope],
    queryFn: () => getFeed(50, activeScope),
    enabled: !counts.isLoading,
  });

  // RefreshControl is inert on react-native-web, so the browser gets the same
  // gesture from here.
  const pull = usePullToRefresh(() => posts.refetch(), posts.isRefetching);

  const circles = useQuery({
    queryKey: ['profile', 'following', profile?.id],
    queryFn: () => getFollowing(profile!.id),
    enabled: Boolean(profile?.id),
  });

  const like = async (post: CommunityPost) => {
    if (!requireAuth('Páči sa mi to je pripnuté k účtu.', () => {})) return;
    try {
      await togglePostLike(post.id, Boolean(post.liked_by_me));
      await queryClient.invalidateQueries({ queryKey: ['feed'] });
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  const share = async (withPhoto: boolean) => {
    const body = draft.trim();
    if (!body && !withPhoto) return;

    setError(null);
    setBusy(true);
    try {
      let imageUrl: string | null = null;

      if (withPhoto) {
        const picked = await pickImage({ source: 'library', aspect: [4, 3] });
        if (!picked) { setBusy(false); return; }
        imageUrl = await uploadCommunityImage(picked.uri, 'feed');
      }

      await createPost({ body: body || '📷', imageUrl, organizationId: postAs });
      setDraft('');
      setComposerOpen(false);
      toast.show('Zdieľané do feedu');
      await queryClient.invalidateQueries({ queryKey: ['feed'] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  if (posts.isLoading) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <EventListSkeleton count={3} />
      </SafeAreaView>
    );
  }

  if (posts.isError) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <ErrorState message={messageFor(posts.error)} onRetry={() => void posts.refetch()} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Feed</Text>
        {/* Two destinations, not one: people are no longer a block inside
            Komunita, so they need their own way in from here. */}
        <View style={styles.headerButtons}>
          <Pressable style={styles.headerButton} onPress={() => router.push('/people')}>
            <Text style={styles.headerButtonLabel}>Ľudia</Text>
          </Pressable>
          <Pressable style={styles.headerButton} onPress={() => router.push('/community')}>
            <Text style={styles.headerButtonLabel}>Komunity</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.scopeRow}>
        {SCOPES.map((option) => (
          <Pressable
            key={option.key}
            onPress={() => setScope(option.key)}
            style={[styles.scope, activeScope === option.key && styles.scopeOn]}
          >
            <Text style={[styles.scopeLabel, activeScope === option.key && styles.scopeLabelOn]}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {error ? <Notice tone="danger" title="Niečo sa pokazilo" body={error} /> : null}

      {pull.indicator}

      <FlatList
        {...pull.handlers}
        data={posts.data ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={posts.isRefetching}
            onRefresh={() => void posts.refetch()}
            tintColor={colors.accent}
          />
        }
        ListFooterComponent={<SiteFooter />}
        ListHeaderComponent={
          <View>
            {(circles.data ?? []).length > 0 ? (
              <FlatList
                horizontal
                data={circles.data ?? []}
                keyExtractor={(item) => item.id}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.stories}
                renderItem={({ item }) => (
                  <Pressable
                    style={styles.story}
                    onPress={() => router.push(`/user/${item.id}`)}
                  >
                    <LinearGradient
                      colors={[colors.accent, colors.pink]}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={styles.storyRing}
                    >
                      <View style={styles.storyInner}>
                        <Avatar
                          url={item.avatar_url}
                          name={item.display_name ?? item.username}
                          size={50}
                        />
                      </View>
                    </LinearGradient>
                    <Text style={styles.storyName} numberOfLines={1}>
                      {item.display_name?.split(' ')[0] ?? item.username}
                    </Text>
                  </Pressable>
                )}
              />
            ) : null}

            <Pressable
              style={styles.composerRow}
              onPress={() =>
                requireAuth('Aby ostatní vedeli, kto moment zdieľa.', () => setComposerOpen(true))
              }
            >
              <Avatar url={profile?.avatar_url} name={profile?.display_name} size={38} />
              <Text style={styles.composerHint}>Zdieľaj moment z eventu…</Text>
              <Text style={styles.composerGlyph}>＋</Text>
            </Pressable>
          </View>
        }
        renderItem={({ item }) => (
          <PostCard post={item} onLike={() => like(item)} />
        )}
        ListEmptyComponent={
          <EmptyState
            emoji="📸"
            title="Feed je zatiaľ prázdny"
            body="Zdieľaj fotku alebo moment z eventu — objaví sa tu a v komunitách, ktorých si členom."
            actionLabel="Zdieľať moment"
            onAction={() => setComposerOpen(true)}
          />
        }
      />

      <BottomSheet
        visible={composerOpen}
        onClose={() => setComposerOpen(false)}
        title="Zdieľaj moment"
        subtitle="Uvidia to ľudia, ktorí ťa sledujú, aj komunity, kde si."
        footer={
          <View style={styles.sheetActions}>
            <Button
              title="＋ Fotka"
              variant="secondary"
              onPress={() => share(true)}
              disabled={busy}
              style={styles.flex}
            />
            <Button
              title="Zdieľať"
              onPress={() => share(false)}
              loading={busy}
              disabled={!draft.trim()}
              style={styles.flex}
            />
          </View>
        }
      >
        {(organizations.data ?? []).length > 0 ? (
          <>
            <Caption style={styles.postAsLabel}>Uverejniť ako</Caption>
            <View style={styles.postAsRow}>
              <Chip
                label={profile?.display_name ?? 'Ja'}
                selected={postAs === null}
                onPress={() => setPostAs(null)}
              />
              {(organizations.data ?? []).map((organization) => (
                <Chip
                  key={organization.id}
                  label={organization.name}
                  selected={postAs === organization.id}
                  onPress={() => setPostAs(organization.id)}
                />
              ))}
            </View>
          </>
        ) : null}

        <Input
          value={draft}
          onChangeText={setDraft}
          placeholder="Ako to bolo?"
          multiline
          maxLength={2000}
          style={styles.sheetInput}
        />
      </BottomSheet>
    </SafeAreaView>
  );
}

function PostCard({ post, onLike }: { post: CommunityPost; onLike: () => void }) {
  return (
    <View style={styles.post}>
      <Pressable
        style={styles.postHeader}
        onPress={() =>
          post.organization
            ? router.push(`/org/${post.organization.slug || post.organization.id}`)
            : post.author && router.push(`/user/${post.author.id}`)
        }
      >
        {post.organization ? (
          post.organization.logo_url ? (
            <Image source={{ uri: post.organization.logo_url }} style={styles.postOrgLogo} />
          ) : (
            <Avatar name={post.organization.name} size={38} />
          )
        ) : (
          <Avatar url={post.author?.avatar_url} name={post.author?.display_name} size={38} />
        )}

        <View style={styles.flex}>
          <Text style={styles.postAuthor} numberOfLines={1}>
            {post.organization?.name
              ?? post.author?.display_name
              ?? post.author?.username
              ?? 'Niekto'}
          </Text>
          {post.event ? (
            <Pressable onPress={() => router.push(eventHref(post.event!))}>
              <Text style={styles.postEvent} numberOfLines={1}>· {post.event.title}</Text>
            </Pressable>
          ) : null}
        </View>

        <Text style={styles.postTime}>{formatRelative(post.created_at)}</Text>
      </Pressable>

      {post.image_url ? (
        <Image source={{ uri: post.image_url }} style={styles.postImage} contentFit="cover" />
      ) : null}

      <Body style={styles.postBody}>{post.body}</Body>

      <View style={styles.postActions}>
        <Pressable
          onPress={onLike}
          style={[styles.likeButton, post.liked_by_me && styles.likeButtonActive]}
        >
          <Text style={[styles.likeGlyph, post.liked_by_me && styles.likeGlyphActive]}>
            {post.liked_by_me ? '♥' : '♡'}
          </Text>
          <Text style={[styles.likeCount, post.liked_by_me && styles.likeGlyphActive]}>
            {formatCount(post.like_count)}
          </Text>
        </Pressable>

        {post.event ? (
          <Pressable
            style={styles.goingButton}
            onPress={() => router.push(eventHref(post.event!))}
          >
            <Text style={styles.goingLabel}>Idem tiež</Text>
          </Pressable>
        ) : null}

        <View style={styles.flex} />

        {post.event_rating && post.event_rating.count > 0 ? (
          <Text style={styles.rating}>★ {post.event_rating.average.toFixed(1)}</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scopeRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.gutter,
    paddingBottom: spacing.md,
  },
  scope: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: radius.chip,
    backgroundColor: colors.surfaceElevated,
  },
  scopeOn: { backgroundColor: colors.accent },
  scopeLabel: { color: colors.textSecondary, fontWeight: '700', fontSize: 13 },
  scopeLabelOn: { color: '#FFFFFF' },
  screen: { flex: 1, backgroundColor: colors.background },
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
  },
  title: { ...typography.screenTitle, color: colors.text },
  headerButtons: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  headerButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 9,
    borderRadius: radius.chip,
    backgroundColor: colors.accentSoft,
  },
  headerButtonLabel: { ...typography.chip, color: colors.accent },

  list: { paddingHorizontal: spacing.gutter, paddingBottom: spacing.xxxl, flexGrow: 1 },

  stories: { gap: spacing.lg, paddingBottom: spacing.lg },
  story: { alignItems: 'center', width: 66, gap: 6 },
  storyRing: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
  },
  storyInner: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  storyName: { ...typography.micro, color: colors.textTertiary },

  composerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.lg,
  },
  composerHint: { ...typography.body, color: colors.textQuaternary, flex: 1 },
  composerGlyph: { fontSize: 20, color: colors.accent },

  post: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  postHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  postAuthor: { ...typography.rowTitleSm, color: colors.text },
  postEvent: { ...typography.metaSm, color: colors.accent, marginTop: 1 },
  postTime: { ...typography.metaSm, color: colors.textMuted },

  postImage: {
    width: '100%',
    height: 190,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceElevated,
  },
  postBody: { color: colors.textSecondary },

  postActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  likeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.lg,
    paddingVertical: 9,
    borderRadius: radius.chip,
    backgroundColor: colors.surfaceElevated,
  },
  likeButtonActive: { backgroundColor: colors.pinkSoft },
  likeGlyph: { fontSize: 15, color: colors.textTertiary },
  likeGlyphActive: { color: colors.pink },
  likeCount: { ...typography.metaSm, color: colors.textTertiary },

  goingButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 9,
    borderRadius: radius.chip,
    backgroundColor: colors.surfaceElevated,
  },
  goingLabel: { ...typography.chip, color: colors.textSecondary },

  rating: { ...typography.metaSm, color: colors.textTertiary },

  sheetInput: { minHeight: 96, textAlignVertical: 'top', marginBottom: 0 },
  postAsLabel: { marginBottom: spacing.sm },
  postAsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
  postOrgLogo: { width: 38, height: 38, borderRadius: radius.md },
  sheetActions: { flexDirection: 'row', gap: spacing.md },
});
