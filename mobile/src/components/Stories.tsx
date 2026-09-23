import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList, Modal, Platform, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  deleteStory, getStoriesOf, getStoryRings, getStoryViewers, markStorySeen,
  type Story, type StoryRing,
} from '@/api/stories';
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
export function StoryRow({ onAdd }: { onAdd: () => void }) {
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
            accessibilityRole="button"
            accessibilityLabel={mine ? 'Tvoj príbeh' : 'Pridať príbeh'}
          >
            <View style={styles.plainRing}>
              <View style={styles.inner}>
                <Avatar url={profile?.avatar_url} name={profile?.display_name} size={50} />
              </View>
              {/* The plus is on your own circle whether or not you have one
                  posted — adding a second story is the same gesture as adding
                  a first, and hiding it behind "you already have one" is how
                  people conclude the feature is missing. */}
              <Pressable
                onPress={onAdd}
                accessibilityRole="button"
                accessibilityLabel="Pridať príbeh"
                style={styles.plus}
              >
                <Text style={styles.plusGlyph}>＋</Text>
              </Pressable>
            </View>
            <Text style={styles.name} numberOfLines={1}>
              {mine ? 'Tvoj príbeh' : 'Pridať'}
            </Text>
          </Pressable>
        }
        renderItem={({ item }) => (
          <Ring ring={item} onPress={() => setOpen(item)} />
        )}
      />

      <StoryViewer ring={open} onClose={() => setOpen(null)} />
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
        <View style={styles.seenRing}>
          <View style={styles.inner}>
            <Avatar
              url={ring.avatar_url}
              name={ring.display_name ?? ring.username}
              size={50}
            />
          </View>
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
  ring, onClose,
}: {
  /** null closes it. The whole ring rather than an id, so the header can name
      whose story this is without a second query for a name the row already had. */
  ring: StoryRing | null;
  onClose: () => void;
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
            <View
              key={story.id}
              style={[styles.bar, at <= index && styles.barOn]}
            />
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
              {isMine ? (
                <Pressable onPress={() => void remove()} hitSlop={10} accessibilityRole="button">
                  <Text style={styles.headGlyph}>🗑</Text>
                </Pressable>
              ) : null}
              <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button">
                <Text style={styles.headGlyph}>✕</Text>
              </Pressable>
            </View>

            <View style={styles.stage}>
              {brokenImage ? (
                <View style={styles.broken}>
                  <Text style={styles.brokenGlyph}>⚠</Text>
                  <Text style={styles.brokenText}>Obrázok sa nepodarilo načítať.</Text>
                </View>
              ) : (
                <Image
                  source={{ uri: current.image_url }}
                  style={styles.picture}
                  contentFit="contain"
                  transition={120}
                  onError={() => setBrokenImage(true)}
                />
              )}

              {/* The two halves. Rendered over the picture rather than round it
                  so the tap targets are the whole screen, which is where a
                  thumb actually lands. */}
              <Pressable style={styles.halfLeft} onPress={previous} accessibilityLabel="Späť" />
              <Pressable style={styles.halfRight} onPress={next} accessibilityLabel="Ďalej" />
            </View>

            {current.caption ? (
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
    borderWidth: 2, borderColor: colors.border,
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
  },
  barOn: { backgroundColor: '#FFFFFF' },

  head: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  headName: { ...typography.bodyStrong, color: '#FFFFFF' },
  headTime: { color: 'rgba(255,255,255,0.7)' },
  headGlyph: { color: '#FFFFFF', fontSize: 18, paddingHorizontal: 6 },

  stage: { flex: 1, position: 'relative' },
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
