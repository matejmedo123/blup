import React, { useMemo, useState } from 'react';
import { EventListSkeleton, DetailSkeleton } from '@/components/Skeleton';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import { useRequireAuth } from '@/auth/useRequireAuth';
import {
  getFeed, getFeedCounts, getFeedNewEvents, type FeedScope, togglePostLike,
  type CommunityPost, type FeedNewEvent,
} from '@/api/communities';
import { createStory } from '@/api/stories';
import {
  pickImage, pickStory, uploadCommunityImage, uploadStoryImage, uploadStoryVideo,
} from '@/storage/uploads';
import { createPost } from '@/api/communities';
import { StoryRow } from '@/components/Stories';
import { StoryCamera, type StoryDraft } from '@/components/StoryCamera';
import { StoryEditor } from '@/components/StoryEditor';
import { SponsoredCard } from '@/components/SponsoredCard';
import { getMyOrganizations } from '@/api/organizations';
import { messageFor } from '@/lib/errors';
import { eventHref, formatCount, formatEventDate, formatPrice, formatRelative } from '@/lib/format';
import { useToast } from '@/components/Toast';
import { BottomSheet } from '@/components/BottomSheet';
import {
  Avatar, Body, Button, Caption, Chip, EmptyState, ErrorState, Input, LoadingState, Notice,
  Screen,
} from '@/components/ui';
import { SiteFooter } from '@/components/SiteFooter';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import { CARD_MAX } from '@/hooks/useLayout';
import { GradientCover } from '@/components/GradientCover';
import { avatarColorFor, colors, radius, spacing, typography } from '@/theme';

/**
 * Feed.
 *
 * Stories across the top (people you follow), then posts: author, the event the
 * post belongs to, the photo, the text, and the actions — like, "Idem tiež",
 * and the event's rating on the right.
 */
/**
 * One row of the feed.
 *
 * A discriminated union rather than a post with a flag on it: an announcement
 * has no body, no likes and no author who typed anything, and giving it those
 * fields as nulls is how a card ends up rendering an empty comment count under
 * an event nobody has commented on.
 */
type FeedRow =
  | { kind: 'post'; at: string; id: string; post: CommunityPost }
  | { kind: 'event'; at: string; id: string; event: FeedNewEvent };

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
  const [storyBusy, setStoryBusy] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  /**
   * Fotka z galérie, ktorá čaká na orezanie.
   *
   * Nenahráva sa rovno: príbeh má jeden rozmer a fotka z galérie ho takmer
   * nikdy nemá. Kým sa nahrávala taká, aká bola, prehrávač ju musel niekam
   * vložiť a okolo ostali pásy. Teraz si výrez zvolí ten, kto ju posiela.
   */
  const [editing, setEditing] = useState<
    { uri: string; width: number; height: number } | null
  >(null);

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

  /**
   * Which view is open.
   *
   * A guest gets exactly one: "Všetko". The other two are about a person —
   * who they follow, what they have shown interest in — and a guest is not a
   * person the app knows anything about. Offering "Pre teba" to somebody with
   * no account is a promise nothing can keep, and what it actually showed was
   * the whole platform with a personal-sounding heading over it.
   *
   * The server agrees now rather than being asked nicely: feed_posts returns
   * nothing for those two scopes when nobody is signed in. This only stops the
   * tabs being drawn.
   */
  const activeScope: FeedScope = isGuest ? 'all' : scope ?? (
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

  /**
   * The other half of the feed: events the people you follow have just put on.
   *
   * Kept as its own query rather than folded into feed_posts, because it is not
   * a post. Writing a post row when somebody publishes an event would put words
   * in their mouth and leave a second copy to drift out of date the moment they
   * edited the real one.
   */
  const announcements = useQuery({
    queryKey: ['feed', 'new-events', activeScope],
    queryFn: () => getFeedNewEvents(activeScope, 20),
    enabled: !counts.isLoading,
  });

  /**
   * One list, in time order.
   *
   * Interleaved by `created_at` rather than shown as a separate band at the
   * top: a band would put a four-day-old announcement above a post from ten
   * minutes ago, which is the thing that teaches people to scroll past the top
   * of a feed.
   */
  const timeline = useMemo<FeedRow[]>(() => {
    const rows: FeedRow[] = [
      ...(posts.data ?? []).map((post) => ({
        kind: 'post' as const, at: post.created_at, id: `post-${post.id}`, post,
      })),
      ...(announcements.data ?? []).map((event) => ({
        kind: 'event' as const, at: event.created_at, id: `event-${event.id}`, event,
      })),
    ];
    rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return rows;
  }, [posts.data, announcements.data]);

  /**
   * Uploads whatever the story ends up being and posts it.
   *
   * A video goes up as it was recorded; a photo goes through the usual
   * downscale. Sending a video down the photo path would flatten it into a
   * single frame.
   */
  const postStory = async (draft: StoryDraft) => {
    setError(null);
    setStoryBusy(true);
    try {
      const url = draft.kind === 'video'
        ? await uploadStoryVideo(draft.uri)
        : await uploadStoryImage(draft.uri);

      await createStory({
        imageUrl: url,
        organizationId: postAs,
        mediaType: draft.kind,
        overlay: draft.overlay ?? null,
      });
      await queryClient.invalidateQueries({ queryKey: ['stories'] });
      toast.show(draft.kind === 'video'
        ? 'Video je vonku — zmizne o 24 hodín'
        : 'Príbeh je vonku — zmizne o 24 hodín');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setStoryBusy(false);
    }
  };

  /** The camera: shoot it here. */
  const addStory = () => {
    if (!requireAuth('Príbeh sa pripína k tvojmu účtu.', () => {})) return;
    setError(null);
    setCameraOpen(true);
  };

  /** The other way in: something already in the library. */
  const addStoryFromLibrary = async () => {
    if (!requireAuth('Príbeh sa pripína k tvojmu účtu.', () => {})) return;
    setError(null);
    try {
      const picked = await pickStory('library');
      if (!picked) return;
      if (picked.kind === 'video') {
        // Video sa v JavaScripte orezať nedá — prekódovanie by trvalo minúty,
        // zohrialo telefón a výsledok by bol horší. Prehráva sa preto v rámčeku
        // príbehu, ktorý má vždy ten istý tvar, takže všetci vidia to isté.
        await postStory({ uri: picked.uri, kind: 'video' });
        return;
      }
      setEditing({ uri: picked.uri, width: picked.width, height: picked.height });
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

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

      {isGuest ? null : (
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
      )}

      {error ? <Notice tone="danger" title="Niečo sa pokazilo" body={error} /> : null}

      {pull.indicator}

      <FlatList
        {...pull.handlers}
        data={timeline}
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
            {/* Real stories. This row used to be every person you follow with a
                gradient ring drawn round them — a ring that always said "there
                is something new here" and never led anywhere but a profile. */}
            <StoryRow
              onAdd={addStory}
              onAddFromLibrary={() => void addStoryFromLibrary()}
            />

            {storyBusy ? <Caption style={styles.storyBusy}>Nahrávam príbeh…</Caption> : null}

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
        renderItem={({ item, index }) => (
          <>
            {item.kind === 'post'
              ? <PostCard post={item.post} onLike={() => like(item.post)} />
              : <NewEventCard event={item.event} />}

            {/* One paid placement, after the third organic row. Third rather
                than first: the feed has to be worth opening before it is worth
                selling. Renders nothing when no advertiser qualifies, which is
                most of the time — so an empty platform shows no slot at all
                rather than a house ad. */}
            {index === 2 ? <SponsoredCard style={styles.sponsored} /> : null}
          </>
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

      <StoryEditor
        photo={editing}
        onCancel={() => setEditing(null)}
        onDone={(draft) => { setEditing(null); void postStory(draft); }}
      />

      <StoryCamera
        visible={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onDone={(draft) => { setCameraOpen(false); void postStory(draft); }}
        onLibrary={() => void addStoryFromLibrary()}
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

/**
 * An event somebody you follow has just put on.
 *
 * Deliberately not an EventCard: in a feed of things people wrote, an event has
 * to carry the byline of whoever put it on, or it reads as an advert that got
 * in. The line above the cover is the whole point of the card.
 */
function NewEventCard({ event }: { event: FeedNewEvent }) {
  const who = event.organization_name ?? event.creator_name ?? event.creator_username;

  return (
    <View style={styles.post}>
      <Pressable
        style={styles.postHeader}
        onPress={() =>
          event.organization_id
            ? router.push(`/org/${event.organization_slug || event.organization_id}`)
            : router.push(`/user/${event.creator_id}`)
        }
      >
        {event.organization_logo_url ? (
          <Image source={{ uri: event.organization_logo_url }} style={styles.postOrgLogo} />
        ) : (
          <Avatar
            url={event.organization_id ? null : event.creator_avatar_url}
            name={who}
            size={38}
          />
        )}
        <View style={styles.flex}>
          <Text style={styles.postAuthor} numberOfLines={1}>{who}</Text>
          {/* „vytvoril" je v slovenčine rodové sloveso a rod človeka nevieme
              — z mena sa hádať nedá. Prítomné „má" rod nemá, takže sedí na
              človeka aj na organizáciu bez toho, aby sa niekto tipoval. */}
          <Caption>má nový event · {formatRelative(event.created_at)}</Caption>
        </View>
        <View style={styles.newTag}>
          <Text style={styles.newTagLabel}>NOVÝ EVENT</Text>
        </View>
      </Pressable>

      <Pressable
        onPress={() => router.push(`/event/${event.slug || event.id}`)}
        accessibilityRole="button"
      >
        {/* `whole` rather than a fixed height: a poster is usually portrait
            and a banner is usually very wide, and cropping either one to the
            same 190px strip throws away the half with the line-up on it. This
            takes the picture's own proportions, within reason. */}
        <GradientCover
          uri={event.cover_image_url}
          category={event.category}
          height={event.cover_image_url ? undefined : 190}
          whole={Boolean(event.cover_image_url)}
          style={styles.postImage}
        />

        <View style={styles.newBody}>
          <Text style={styles.newTitle} numberOfLines={2}>{event.title}</Text>
          <Caption>
            {formatEventDate(event.start_at)}
            {event.venue_name ? ` · ${event.venue_name}` : event.city ? ` · ${event.city}` : ''}
          </Caption>

          <View style={styles.newFooter}>
            <Text style={styles.newGoing}>
              {event.attendee_count > 0
                ? `${formatCount(event.attendee_count)} ide`
                : 'Zatiaľ nikto — buď prvý'}
            </Text>
            <View style={styles.newPrice}>
              <Text style={styles.newPriceLabel}>
                {event.is_free ? 'ZDARMA' : formatPrice(event.price_cents, event.currency)}
              </Text>
            </View>
          </View>
        </View>
      </Pressable>
    </View>
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
          <Avatar
            url={post.author?.avatar_url}
            name={post.author?.display_name}
            size={38}
            userId={post.author?.id}
          />
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

  /**
   * Capped, not full-bleed.
   *
   * The feed spanned the whole window, so on a desktop a card grew to two
   * thousand pixels wide while its cover stayed 190px tall — a poster served
   * as a letterbox strip with the middle third of it showing. CARD_MAX is the
   * width the rest of the app already reads at; centring it is what everything
   * else does with a single column.
   */
  list: {
    paddingHorizontal: spacing.gutter,
    paddingBottom: spacing.xxxl,
    flexGrow: 1,
    width: '100%',
    maxWidth: CARD_MAX,
    alignSelf: 'center',
  },

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

  storyBusy: { paddingHorizontal: spacing.xs, paddingBottom: spacing.sm },
  sponsored: { marginBottom: spacing.lg },

  newTag: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.chip,
    backgroundColor: colors.accentSoft,
  },
  newTagLabel: { ...typography.monoSm, fontSize: 9, color: colors.accentText },
  newBody: { padding: spacing.md, gap: 4 },
  newTitle: { ...typography.rowTitle, color: colors.text },
  newFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  newGoing: { ...typography.metaSm, color: colors.accent, flex: 1 },
  newPrice: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.chip,
    backgroundColor: colors.surfaceElevated2,
  },
  newPriceLabel: { ...typography.monoSm, color: colors.text },
  sheetActions: { flexDirection: 'row', gap: spacing.md },
});
