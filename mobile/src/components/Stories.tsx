import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, Easing, FlatList, Modal, Platform, Pressable, StyleSheet, Text, View,
  type LayoutChangeEvent,
} from 'react-native';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  deleteStory, getStoriesOf, getStoryRings, getStoryViewers, markStorySeen,
  type Story, type StoryRing,
} from '@/api/stories';
import { StoryText } from '@/components/StoryText';
import { storyFrame } from '@/components/storyFormat';
import { useAuth } from '@/auth/AuthProvider';
import { messageFor } from '@/lib/errors';
import { formatRelative } from '@/lib/format';
import { useDialog } from '@/components/Dialog';
import { Avatar, Caption, Mono } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Príbehy — the row above the feed, and the thing it opens.
 *
 * The row used to be a list of everybody you follow with a gradient ring drawn
 * round each face. Every ring said "there is something new here" and none of
 * them led anywhere but a profile; the ring was decoration wearing the costume
 * of a notification. Now a ring means one thing: this person has posted
 * something in the last 24 hours, and it is unwatched if the ring is coloured.
 */
export function StoryRow({
  onAdd, onAddFromLibrary,
}: {
  /** Opens the camera. */
  onAdd: () => void;
  /** Takes something that is already in the library. */
  onAddFromLibrary?: () => void;
}) {
  const { profile, isGuest } = useAuth();
  /** Who is being watched — the whole ring, so the viewer can name them. */
  const [open, setOpen] = useState<StoryRing | null>(null);

  const rings = useQuery({
    queryKey: ['stories', 'rings'],
    queryFn: () => getStoryRings(30),
    enabled: !isGuest,
    // A story is a 24-hour object; a minute of staleness is not worth a
    // request on every remount.
    staleTime: 60_000,
  });

  const list = rings.data ?? [];
  const mine = list.find((ring) => ring.is_mine) ?? null;
  const others = list.filter((ring) => !ring.is_mine);

  // A guest has nobody to follow and nothing to post, so the row is simply not
  // there rather than being an empty strip of grey circles.
  if (isGuest) return null;

  return (
    <>
      <FlatList
        horizontal
        data={others}
        keyExtractor={(item) => item.author_id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        ListHeaderComponent={
          <Pressable
            style={styles.item}
            onPress={() => (mine ? setOpen(mine) : onAdd())}
            // Shooting one is the tap; taking one you already have is the
            // hold. Both are here rather than behind a menu, because a menu
            // for two things is a menu nobody opens.
            onLongPress={onAddFromLibrary}
            accessibilityRole="button"
            accessibilityLabel={mine ? 'Tvoj príbeh' : 'Pridať príbeh'}
          >
            {/* Once you have posted, your own circle is lit like everybody
                else's and the plus goes — that ring IS the confirmation that
                the story went out. Before that it is a plain circle with a
                plus on it, which is the only state where the plus means
                anything. Adding a second one lives inside your own story. */}
            {mine ? (
              <LinearGradient
                colors={[colors.accent, colors.pink]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.ring}
              >
                <View style={styles.inner}>
                  <Avatar url={profile?.avatar_url} name={profile?.display_name} size={50} />
                </View>
              </LinearGradient>
            ) : (
              <View style={styles.plainRing}>
                <View style={styles.inner}>
                  <Avatar url={profile?.avatar_url} name={profile?.display_name} size={50} />
                </View>
                <View style={styles.plus}>
                  <Text style={styles.plusGlyph}>＋</Text>
                </View>
              </View>
            )}
            <Text style={styles.name} numberOfLines={1}>
              {mine ? 'Tvoj príbeh' : 'Pridať'}
            </Text>
          </Pressable>
        }
        renderItem={({ item }) => (
          <Ring ring={item} onPress={() => setOpen(item)} />
        )}
      />

      <StoryViewer ring={open} onClose={() => setOpen(null)} onAdd={onAdd} />
    </>
  );
}

function Ring({ ring, onPress }: { ring: StoryRing; onPress: () => void }) {
  const unseen = ring.unseen_count > 0;

  return (
    <Pressable style={styles.item} onPress={onPress} accessibilityRole="button">
      {/* Coloured only while there is something you have not seen. A ring that
          is always on is a ring that means nothing. */}
      {unseen ? (
        <LinearGradient
          colors={[colors.accent, colors.pink]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.ring}
        >
          <View style={styles.inner}>
            <Avatar
              url={ring.avatar_url}
              name={ring.display_name ?? ring.username}
              size={50}
            />
          </View>
        </LinearGradient>
      ) : (
        // Watched: no ring at all, just the face. A grey ring was still a ring
        // — from the corner of your eye it reads as "something here" exactly
        // like the coloured one, so the row looked equally busy whether there
        // was anything new in it or not. Everybody in this row has a live
        // story and is tappable, so nothing is lost by taking it off: the ring
        // now means one thing only, and it means it loudly.
        <View style={styles.seenRing}>
          <Avatar
            url={ring.avatar_url}
            name={ring.display_name ?? ring.username}
            size={RING - 6}
          />
        </View>
      )}
      <Text style={[styles.name, !unseen && styles.nameSeen]} numberOfLines={1}>
        {ring.display_name?.split(' ')[0] ?? ring.username}
      </Text>
    </Pressable>
  );
}

/**
 * The viewer.
 *
 * Full screen, one story at a time, tap the right half for the next and the
 * left half for the previous — the gesture everybody already has. It does not
 * advance on a timer: an auto-advancing story that moves on while somebody is
 * reading the caption is a way of hiding what was posted.
 */
export function StoryViewer({
  ring, onClose, onAdd,
}: {
  /** null closes it. The whole ring rather than an id, so the header can name
      whose story this is without a second query for a name the row already had. */
  ring: StoryRing | null;
  onClose: () => void;
  /** Posting another one. Only offered inside your own story. */
  onAdd?: () => void;
}) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const dialog = useDialog();
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showViewers, setShowViewers] = useState(false);
  /**
   * The picture failed to load.
   *
   * Without this the stage is simply black, which is indistinguishable from
   * somebody having posted a black picture — and from the viewer being broken.
   */
  const [brokenImage, setBrokenImage] = useState(false);
  /**
   * How big the 9:16 frame is, measured rather than assumed.
   *
   * The stage is what is left after the progress bars, the header and whatever
   * sits under the picture, and that differs per platform and per story — a
   * caption and an event link take room, a bare photo does not. Asking the
   * layout is the only way to get a frame that fits every one of those.
   */
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const onStageLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setStage((current) =>
      current.width === width && current.height === height ? current : { width, height });
  }, []);
  const frame = useMemo(
    () => storyFrame(stage.width, stage.height),
    [stage.width, stage.height],
  );
  /**
   * Held down to keep reading.
   *
   * A story that moves on by itself is fine until there is a caption on it —
   * then the timer is deciding how long you are allowed to read. Pressing and
   * holding stops the clock, which is the gesture people already use.
   */
  const [held, setHeld] = useState(false);
  /** 0 → 1 over STORY_MS, drawn as the fill of the current bar. */
  const progress = useRef(new Animated.Value(0)).current;

  const authorId = ring?.author_id ?? null;

  const stories = useQuery({
    queryKey: ['stories', 'of', authorId],
    queryFn: () => getStoriesOf(authorId!),
    enabled: Boolean(authorId),
  });

  const items = useMemo(() => stories.data ?? [], [stories.data]);
  const current: Story | undefined = items[index];
  const isMine = current?.author_id === profile?.id;

  // A fresh open starts at the beginning, not wherever the last one ended.
  useEffect(() => {
    setIndex(0);
    setShowViewers(false);
    setError(null);
    setBrokenImage(false);
    setHeld(false);
  }, [authorId]);

  // Each story gets its own verdict; one that failed says nothing about the next.
  useEffect(() => { setBrokenImage(false); }, [index]);

  // Watching is recorded per story, when it is actually on screen.
  useEffect(() => {
    if (!current || current.seen_by_me || isMine) return;
    void markStorySeen(current.id).then(() => {
      void queryClient.invalidateQueries({ queryKey: ['stories', 'rings'] });
    });
  }, [current, isMine, queryClient]);

  const next = useCallback(() => {
    setIndex((value) => {
      if (value + 1 >= items.length) {
        onClose();
        return value;
      }
      return value + 1;
    });
  }, [items.length, onClose]);

  const previous = useCallback(() => {
    setIndex((value) => Math.max(0, value - 1));
  }, []);

  /**
   * Ten seconds, then the next one.
   *
   * The bar above fills over that time, so the clock is visible rather than a
   * surprise. Held down it stops; it also does not run at all while the
   * picture is still loading or has failed, because counting down over a blank
   * screen spends the ten seconds on nothing.
   */
  const running = Boolean(authorId) && Boolean(current) && !held && !brokenImage;

  useEffect(() => {
    if (!running) return;
    progress.setValue(0);
    const run = Animated.timing(progress, {
      toValue: 1,
      duration: STORY_MS,
      easing: Easing.linear,
      useNativeDriver: false,
    });
    run.start(({ finished }) => { if (finished) next(); });
    return () => run.stop();
  }, [running, index, authorId, progress, next]);

  const onKey = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Escape') onClose();
    if (event.key === 'ArrowRight') next();
    if (event.key === 'ArrowLeft') previous();
  }, [onClose, next, previous]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !authorId) return;
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [authorId, onKey]);

  const remove = async () => {
    if (!current) return;
    const sure = await dialog.confirm({
      title: 'Zmazať príbeh?',
      body: 'Zmizne hneď, nielen o 24 hodín. Vrátiť sa to nedá.',
      confirmLabel: 'Zmazať',
      destructive: true,
    });
    if (!sure) return;

    try {
      await deleteStory(current.id);
      await queryClient.invalidateQueries({ queryKey: ['stories'] });
      onClose();
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  return (
    <Modal
      visible={Boolean(authorId)}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        {/* How far through, one bar per story. Without it there is no way to
            tell a single story from the first of nine. */}
        <View style={styles.bars}>
          {items.map((story, at) => (
            <View key={story.id} style={styles.bar}>
              {/* Watched ones are full, the one playing fills as it goes, the
                  rest are empty — so the bar says both where you are and how
                  long is left. */}
              <Animated.View
                style={[
                  styles.barFill,
                  // Not yet watched: empty. Watched: full. Playing: animated.
                  at > index && styles.barEmpty,
                  at < index && styles.barDone,
                  // scaleX, not an animated width. A width given as a
                  // percentage does not animate on react-native-web — the bar
                  // simply sat at full from the first frame — and a transform
                  // is what the compositor can move without a layout pass
                  // anyway. transformOrigin keeps it growing from the left
                  // instead of out from the middle.
                  at === index && {
                    transform: [{ scaleX: progress }],
                    transformOrigin: 'left center',
                  },
                ]}
              />
            </View>
          ))}
        </View>

        {current ? (
          <>
            <View style={styles.head}>
              <Avatar
                size={34}
                url={ring?.avatar_url}
                name={ring?.display_name ?? ring?.username}
              />
              <View style={styles.flex}>
                <Text style={styles.headName} numberOfLines={1}>
                  {ring?.display_name ?? ring?.username ?? 'Príbeh'}
                </Text>
                <Mono style={styles.headTime}>{formatRelative(current.created_at)}</Mono>
              </View>
              {/* Adding another and deleting this one are both things you do
                  to your own story, so they sit together and they are on
                  screen from the first frame — rather than at the bottom,
                  under the caption and the viewer list, where it moved about
                  and competed with the part you came to read. */}
              {isMine && onAdd ? (
                <Pressable
                  onPress={() => { onClose(); onAdd(); }}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Pridať ďalší príbeh"
                >
                  <Text style={styles.headGlyph}>＋</Text>
                </Pressable>
              ) : null}
              {isMine ? (
                <Pressable onPress={() => void remove()} hitSlop={10} accessibilityRole="button">
                  <Text style={styles.headGlyph}>🗑</Text>
                </Pressable>
              ) : null}
              <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button">
                <Text style={styles.headGlyph}>✕</Text>
              </Pressable>
            </View>

            <View style={styles.stage} onLayout={onStageLayout}>
              {/* Rámček 9:16, v ktorom príbeh žije.
                  Príbeh sa nahráva v jednom rozmere — 1080 × 1920 — takže
                  prehrávač nemá čo dorovnávať a `cover` nič neoreže. Rámček
                  je tu pre obrazovky, ktoré ten pomer nemajú: na širokom
                  monitore je čierno po stranách, nie roztiahnutá fotka, a na
                  veľmi vysokom telefóne nezostane pás hore a dole. */}
              <View style={[styles.frame, frame]}>
              {brokenImage ? (
                <View style={styles.broken}>
                  <Text style={styles.brokenGlyph}>⚠</Text>
                  <Text style={styles.brokenText}>
                    {current.media_type === 'video'
                      ? 'Video sa nepodarilo načítať.'
                      : 'Obrázok sa nepodarilo načítať.'}
                  </Text>
                </View>
              ) : current.media_type === 'video' ? (
                <StoryVideo
                  uri={current.image_url}
                  paused={held}
                  onError={() => setBrokenImage(true)}
                />
              ) : (
                <Image
                  source={{ uri: current.image_url }}
                  style={styles.picture}
                  contentFit="cover"
                  transition={120}
                  onError={() => setBrokenImage(true)}
                />
              )}

              {/* The two halves. Rendered over the picture rather than round it
                  so the tap targets are the whole screen, which is where a
                  thumb actually lands. */}
              {/* The text the author wrote over it. Above the picture and
                  below the tap targets, so reading it never eats a tap. */}
              {current.overlay?.text ? (
                <StoryText overlay={current.overlay} />
              ) : null}
              </View>

              <Pressable
                style={styles.halfLeft}
                onPress={previous}
                onPressIn={() => setHeld(true)}
                onPressOut={() => setHeld(false)}
                accessibilityLabel="Späť"
              />
              <Pressable
                style={styles.halfRight}
                onPress={next}
                onPressIn={() => setHeld(true)}
                onPressOut={() => setHeld(false)}
                accessibilityLabel="Ďalej"
              />
            </View>

            {current.caption && current.caption !== current.overlay?.text ? (
              <Text style={styles.caption}>{current.caption}</Text>
            ) : null}

            {current.event_id ? (
              <Pressable
                style={styles.eventLink}
                onPress={() => {
                  onClose();
                  router.push(`/event/${current.event_slug || current.event_id}`);
                }}
              >
                <Text style={styles.eventLinkLabel} numberOfLines={1}>
                  ◉ {current.event_title ?? 'Otvoriť event'}
                </Text>
              </Pressable>
            ) : null}

            {isMine ? (
              <Pressable
                style={styles.viewers}
                onPress={() => setShowViewers((value) => !value)}
                accessibilityRole="button"
              >
                <Text style={styles.viewersLabel}>
                  👁 {current.view_count} {current.view_count === 1 ? 'videl' : 'videli'}
                </Text>
              </Pressable>
            ) : null}

            {isMine && showViewers ? <Viewers storyId={current.id} /> : null}

            {error ? <Text style={styles.error}>{error}</Text> : null}
          </>
        ) : stories.isLoading ? (
          <Text style={styles.loading}>Načítavam…</Text>
        ) : (
          <View style={styles.gone}>
            <Text style={styles.goneText}>Tento príbeh už vypršal.</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Text style={styles.headGlyph}>✕</Text>
            </Pressable>
          </View>
        )}
      </View>
    </Modal>
  );
}

/**
 * A story that is a video.
 *
 * Muted and looping, like every story player: a clip that starts talking out
 * loud is the reason people stop opening them. Holding the screen pauses it,
 * the same press that pauses the ten-second clock — so the two never disagree
 * about whether the story is running.
 */
function StoryVideo({
  uri, paused, onError,
}: {
  uri: string;
  paused: boolean;
  onError: () => void;
}) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.loop = true;
    instance.muted = true;
    instance.play();
  });

  useEffect(() => {
    if (paused) player.pause();
    else player.play();
  }, [paused, player]);

  // The player reports a bad source through status, not by throwing.
  useEffect(() => {
    const subscription = player.addListener('statusChange', ({ status }) => {
      if (status === 'error') onError();
    });
    return () => subscription.remove();
  }, [player, onError]);

  return (
    <VideoView
      player={player}
      style={styles.picture}
      contentFit="cover"
      nativeControls={false}
    />
  );
}

/** Who watched one of mine. The server refuses this for anybody else's. */
function Viewers({ storyId }: { storyId: string }) {
  const viewers = useQuery({
    queryKey: ['stories', 'viewers', storyId],
    queryFn: () => getStoryViewers(storyId),
  });

  const list = viewers.data ?? [];
  if (list.length === 0) {
    return <Caption style={styles.viewerEmpty}>Zatiaľ nikto.</Caption>;
  }

  return (
    <FlatList
      data={list}
      keyExtractor={(item) => item.viewer_id}
      style={styles.viewerList}
      renderItem={({ item }) => (
        <View style={styles.viewerRow}>
          <Avatar url={item.avatar_url} name={item.display_name ?? item.username} size={28} />
          <Text style={styles.viewerName} numberOfLines={1}>
            {item.display_name ?? item.username}
          </Text>
          <Mono style={styles.viewerTime}>{formatRelative(item.seen_at)}</Mono>
        </View>
      )}
    />
  );
}

/** How long one story stays up before the next one. */
const STORY_MS = 10_000;

const RING = 58;

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },

  row: { gap: spacing.md, paddingVertical: spacing.sm },
  item: { alignItems: 'center', gap: 5, width: 66 },
  ring: {
    width: RING, height: RING, borderRadius: RING / 2,
    alignItems: 'center', justifyContent: 'center',
  },
  seenRing: {
    width: RING, height: RING, borderRadius: RING / 2,
    alignItems: 'center', justifyContent: 'center',
  },
  plainRing: {
    width: RING, height: RING, borderRadius: RING / 2,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: colors.border,
  },
  inner: {
    width: RING - 6, height: RING - 6, borderRadius: (RING - 6) / 2,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.background,
  },
  plus: {
    position: 'absolute', right: -2, bottom: -2,
    width: 20, height: 20, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.accent,
    borderWidth: 2, borderColor: colors.background,
  },
  plusGlyph: { color: '#FFFFFF', fontSize: 12, lineHeight: 14 },
  name: { ...typography.metaSm, color: colors.textSecondary, maxWidth: 64 },
  nameSeen: { color: colors.textTertiary },

  backdrop: { flex: 1, backgroundColor: '#04060A', paddingTop: 44 },
  bars: { flexDirection: 'row', gap: 4, paddingHorizontal: spacing.md },
  bar: {
    flex: 1, height: 3, borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.22)',
    overflow: 'hidden',
  },
  barFill: { width: '100%', height: '100%', borderRadius: 2, backgroundColor: '#FFFFFF' },
  barDone: { transform: [{ scaleX: 1 }] },
  barEmpty: { transform: [{ scaleX: 0 }], transformOrigin: 'left center' },

  head: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  headName: { ...typography.bodyStrong, color: '#FFFFFF' },
  headTime: { color: 'rgba(255,255,255,0.7)' },
  headGlyph: { color: '#FFFFFF', fontSize: 18, paddingHorizontal: 6 },

  stage: { flex: 1, position: 'relative', alignItems: 'center', justifyContent: 'center' },
  frame: { position: 'relative', overflow: 'hidden', backgroundColor: '#000000' },
  picture: { width: '100%', height: '100%' },
  broken: {
    flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
  },
  brokenGlyph: { fontSize: 28, color: 'rgba(255,255,255,0.6)' },
  brokenText: { ...typography.body, color: 'rgba(255,255,255,0.7)' },
  halfLeft: { position: 'absolute', left: 0, top: 0, bottom: 0, width: '35%' },
  halfRight: { position: 'absolute', right: 0, top: 0, bottom: 0, width: '65%' },

  caption: {
    ...typography.body, color: '#FFFFFF',
    paddingHorizontal: spacing.lg, paddingTop: spacing.md,
  },
  eventLink: {
    margin: spacing.lg, marginBottom: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.14)',
    alignSelf: 'flex-start',
  },
  eventLinkLabel: { ...typography.metaSm, color: '#FFFFFF' },

  viewers: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  viewersLabel: { ...typography.metaSm, color: 'rgba(255,255,255,0.78)' },
  viewerList: { maxHeight: 180, paddingHorizontal: spacing.lg },
  viewerRow: {
    flexDirection: 'row', alignItems: 'center',
    gap: spacing.sm, paddingVertical: 6,
  },
  viewerName: { ...typography.metaSm, color: '#FFFFFF', flex: 1 },
  viewerTime: { color: 'rgba(255,255,255,0.55)' },
  viewerEmpty: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md },

  loading: { ...typography.body, color: '#FFFFFF', textAlign: 'center', marginTop: spacing.xxl },
  gone: { alignItems: 'center', gap: spacing.md, marginTop: spacing.xxl },
  goneText: { ...typography.body, color: '#FFFFFF' },
  error: {
    ...typography.metaSm, color: colors.danger,
    paddingHorizontal: spacing.lg, paddingBottom: spacing.md,
  },
});
