import { eventHref } from '@/lib/format';
import { EventListSkeleton, DetailSkeleton } from '@/components/Skeleton';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { Wordmark } from '@/components/Wordmark';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import { useLocation } from '@/hooks/useLocation';
import { getFeedEvents, saveEvent, unsaveEvent } from '@/api/events';
import { getFollowing } from '@/api/profiles';
import { getAIRecommendations } from '@/api/ai';
import { getUnreadCount } from '@/api/notifications';
import { touchActivity } from '@/api/gamification';
import { recordSignal, queueImpression } from '@/api/signals';
import { supabase } from '@/lib/supabase';
import { messageFor } from '@/lib/errors';
import { EventCard } from '@/components/EventCard';
import { useLayout } from '@/hooks/useLayout';
import { useRequireAuth } from '@/auth/useRequireAuth';
import { EventMap } from '@/components/EventMap';
import { useToast } from '@/components/Toast';
import { BottomSheet } from '@/components/BottomSheet';
import {
  AvatarStack, Body, Button, EmptyState, ErrorState, IconButton, LoadingState, Notice,
} from '@/components/ui';
import {
  categoriesInFamily, categoryFilters, colors, radius, shadow, spacing, typography,
  type CategoryFamily,
} from '@/theme';
import type { EventFeedItem } from '@/types/models';

type View_ = 'list' | 'map';

/**
 * Domov.
 *
 * The city header with the notification bell and search, the Zoznam/Mapa
 * switch, the category chips, then: your circles, the big event cards, the AI
 * "Pre teba" rail, and the two banners. Everything comes from the database —
 * an empty database shows the empty state, not a demo event.
 */
export default function HomeScreen() {
  const { requireAuth } = useRequireAuth();
  const layout = useLayout();
  const { profile, isGuest } = useAuth();
  const location = useLocation({ watch: true });
  const queryClient = useQueryClient();
  const toast = useToast();

  const [view, setView] = useState<View_>('list');
  const [family, setFamily] = useState<CategoryFamily | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [weeklyOpen, setWeeklyOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const coords = location.coords;
  const categories = useMemo(() => (family ? categoriesInFamily(family) : []), [family]);

  const nearby = useQuery({
    queryKey: ['events', 'nearby', coords?.latitude, coords?.longitude, categories],
    queryFn: () =>
      getFeedEvents({
        latitude: coords?.latitude,
        longitude: coords?.longitude,
        radiusM: 50000,
        categories,
        limit: 60,
      }),
    // No `enabled`: browsing needs neither an account nor a location. A guest
    // sees the same events a member does, and a visitor who refused location
    // gets the upcoming list rather than an empty city.
  });

  const circles = useQuery({
    queryKey: ['profile', 'following', profile?.id],
    queryFn: () => getFollowing(profile!.id),
    enabled: Boolean(profile?.id),
  });

  const recommendations = useQuery({
    queryKey: ['ai', 'recommendations', coords?.latitude, coords?.longitude],
    queryFn: () =>
      getAIRecommendations({ coords, limit: 8 }),
    // The recommender runs under the caller's session; a guest gets the plain
    // nearby feed instead, which is the honest fallback rather than a 401.
    enabled: Boolean(coords) && !isGuest,
  });

  const recommended = recommendations.data?.events ?? [];

  const { data: unreadNotifications } = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: getUnreadCount,
    enabled: !isGuest,
    refetchInterval: 60_000,
  });

  // Records that the account was open today, which is what drives the streak.
  // A guest has no streak to keep, and no account for this to be about.
  useEffect(() => {
    if (isGuest) return;
    touchActivity()
      .then((result) => {
        if (result?.xp_awarded) {
          void queryClient.invalidateQueries({ queryKey: ['gamification'] });
        }
      })
      .catch(() => undefined);
  }, [queryClient, isGuest]);

  // Realtime: an event created by anyone shows up without a refresh.
  useEffect(() => {
    const channel = supabase
      .channel('home-events')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'events' },
        () => {
          void queryClient.invalidateQueries({ queryKey: ['events'] });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  // Impressions feed the ranker; queued so scrolling is not a write storm.
  useEffect(() => {
    for (const event of nearby.data ?? []) queueImpression(event.id);
  }, [nearby.data]);

  const toggleSave = useCallback(
    async (event: EventFeedItem) => {
      // Browsing needs no account; keeping something does.
      if (!requireAuth('Uložené eventy nájdeš v profile — na to treba účet.', () => {})) return;
      setError(null);
      try {
        if (event.is_saved) {
          await unsaveEvent(event.id);
          toast.show('Blup odobraný');
        } else {
          await saveEvent(event.id);
          await recordSignal(event.id, 'save');
          toast.show('Blupnuté, uložené do Ja');
        }
        await queryClient.invalidateQueries({ queryKey: ['events'] });
      } catch (caught) {
        setError(messageFor(caught));
      }
    },
    [queryClient, toast, requireAuth],
  );

  const openEvent = (event: EventFeedItem) => {
    void recordSignal(event.id, 'open_detail');
    router.push(eventHref(event));
  };

  const events = nearby.data ?? [];
  const selected = events.find((event) => event.id === selectedId) ?? null;

  // The weekly digest picks the best of the coming week from the same ranker
  // the notification uses.
  const weekly = useMemo(() => {
    const horizon = Date.now() + 7 * 24 * 60 * 60 * 1000;
    return recommended
      .filter((event) => {
        const start = new Date(event.start_at).getTime();
        return Number.isFinite(start) && start > Date.now() && start <= horizon;
      })
      .slice(0, 3);
  }, [recommended]);

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      {/* --- header --------------------------------------------------------- */}
      {/* On a desktop the sidebar carries the wordmark; on a phone there was
          nothing to say whose app this is. Small, above the fold, and a tap
          takes you home from wherever the scroll got to. */}
      {!layout.isWide ? (
        <Pressable
          onPress={() => router.push('/')}
          accessibilityRole="button"
          accessibilityLabel="Blup — domov"
          style={styles.brandRow}
        >
          <Wordmark size={19} />
        </Pressable>
      ) : null}

      <View style={styles.header}>
        <View style={styles.flex}>
          {/* Once the events are on screen, "Zisťujem polohu" is no longer true
              — the position is known, only its name is not. */}
          <Text style={styles.city}>
            ◎ {(location.city ?? (coords ? 'V tvojom okolí' : 'Zisťujem polohu')).toUpperCase()}
          </Text>
          <Text style={styles.title}>Dnes okolo teba</Text>
        </View>

        <View style={styles.headerActions}>
          {isGuest ? (
            // The only thing a guest is nudged towards, once, in the corner —
            // not a banner over the events they came to look at.
            <Button
              title="Prihlásiť sa"
              variant="secondary"
              compact
              onPress={() => router.push('/(auth)/sign-in')}
            />
          ) : (
            <IconButton
              glyph="◔"
              size={42}
              badge={(unreadNotifications ?? 0) > 0}
              onPress={() => router.push('/activity')}
            />
          )}
          <IconButton glyph="⌕" size={42} onPress={() => router.push('/search')} />
        </View>
      </View>

      {/* --- view switch ----------------------------------------------------- */}
      <View style={[styles.switchRow, layout.isWide && styles.switchRowWide]}>
        {(['list', 'map'] as View_[]).map((option) => (
          <Pressable
            key={option}
            onPress={() => setView(option)}
            style={[styles.switch, view === option && styles.switchActive]}
          >
            <Text style={[styles.switchLabel, view === option && styles.switchLabelActive]}>
              {option === 'list' ? 'Zoznam' : 'Mapa'}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* --- categories ------------------------------------------------------ */}
      {layout.isWide ? (
        <View style={styles.chipWrap}>
          <Pressable
            onPress={() => setFamily(null)}
            style={[styles.chip, family === null && styles.chipActive]}
          >
            <Text style={[styles.chipLabel, family === null && styles.chipLabelActive]}>Všetko</Text>
          </Pressable>
          {categoryFilters.map((filter) => (
            <Pressable
              key={filter.key}
              onPress={() => setFamily(family === filter.key ? null : filter.key)}
              style={[styles.chip, family === filter.key && styles.chipActive]}
            >
              <Text style={[styles.chipLabel, family === filter.key && styles.chipLabelActive]}>
                {filter.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : (
      <View style={styles.chipRail}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
        style={styles.chipScroll}
      >
        <Pressable
          onPress={() => setFamily(null)}
          style={[styles.chip, family === null && styles.chipActive]}
        >
          <Text style={[styles.chipLabel, family === null && styles.chipLabelActive]}>Všetko</Text>
        </Pressable>

        {categoryFilters.map((filter) => (
          <Pressable
            key={filter.key}
            onPress={() => setFamily(family === filter.key ? null : filter.key)}
            style={[styles.chip, family === filter.key && styles.chipActive]}
          >
            <Text style={[styles.chipLabel, family === filter.key && styles.chipLabelActive]}>
              {filter.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
        {/* Fades the last chip out instead of slicing it, so the rail reads as
            "there is more this way". pointerEvents none or it would swallow the
            tap on the chip underneath it. */}
        <LinearGradient
          colors={['rgba(10,13,18,0)', colors.background]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          pointerEvents="none"
          style={styles.chipFade}
        />
      </View>
      )}

      {error ? <Notice tone="danger" title="Toto sa nepodarilo" body={error} /> : null}

      {!coords && location.status !== 'requesting' ? (
        <View style={styles.locationGate}>
          <Notice
            tone="accent"
            title="Zapni polohu"
            body="BLUP zoradí eventy podľa toho, ako ďaleko naozaj sú."
            actionLabel="Zapnúť polohu"
            onAction={() => void location.request()}
          />
        </View>
      ) : null}

      {/* --- content --------------------------------------------------------- */}
      {view === 'map' ? (
        <View style={styles.mapWrapper}>
          <EventMap
            events={events}
            userLocation={coords}
            selectedId={selectedId}
            onSelect={(event) => setSelectedId(event.id)}
            onDeselect={() => setSelectedId(null)}
            style={styles.map}
          />

          {selected ? (
            <Pressable style={styles.mapCard} onPress={() => openEvent(selected)}>
              <View style={styles.mapThumb}>
                <Text style={styles.mapThumbGlyph}>◉</Text>
              </View>
              <View style={styles.flex}>
                <Text style={styles.mapTitle} numberOfLines={1}>{selected.title}</Text>
                <Text style={styles.mapMeta} numberOfLines={1}>
                  {selected.venue_name ?? selected.city ?? ''}
                </Text>
                <Text style={styles.mapGoing}>{selected.attendee_count} ide</Text>
              </View>
              <View style={styles.mapButton}>
                <Text style={styles.mapButtonLabel}>Detail</Text>
              </View>
              {/* The card covers the pins underneath it, so it needs a way out
                  that is not "open the event". Its own Pressable, so the tap
                  never reaches the card behind it. */}
              <Pressable
                onPress={() => setSelectedId(null)}
                accessibilityRole="button"
                accessibilityLabel="Zavrieť"
                hitSlop={10}
                style={({ pressed }) => [styles.mapClose, pressed && styles.pressed]}
              >
                <Text style={styles.mapCloseGlyph}>×</Text>
              </Pressable>
            </Pressable>
          ) : null}
        </View>
      ) : nearby.isLoading ? (
        <EventListSkeleton count={4} />
      ) : nearby.isError ? (
        <ErrorState message={messageFor(nearby.error)} onRetry={() => void nearby.refetch()} />
      ) : (
        <FlatList
          // Changing numColumns needs a fresh list instance; without the key
          // React Native keeps the old cell layout and the grid comes out
          // half-collapsed after a window resize.
          key={`events-${layout.columns}`}
          numColumns={layout.columns}
          columnWrapperStyle={layout.columns > 1 ? styles.column : undefined}
          data={events}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.list, layout.isWide && styles.listWide]}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={nearby.isRefetching}
              onRefresh={() => void nearby.refetch()}
              tintColor={colors.accent}
            />
          }
          ListHeaderComponent={
            <View>
              {(circles.data ?? []).length > 0 ? (
                <Pressable style={styles.circles} onPress={() => router.push('/community')}>
                  <AvatarStack
                    people={(circles.data ?? []).slice(0, 5).map((person) => ({
                      id: person.id,
                      avatar_url: person.avatar_url,
                      name: person.display_name ?? person.username,
                    }))}
                    size={30}
                    max={5}
                  />
                  <Text style={styles.circlesLabel}>Tvoje kruhy dnes niekam idú</Text>
                </Pressable>
              ) : null}

              {/* Moved up out of the footer. It used to sit after every event
                  card, so on a city with anything happening you had to scroll
                  the whole list to reach it — which is why it read as missing. */}
                  {/* --- for you --------------------------------------------- */}
                  {recommended.length > 0 ? (
                    <>
                      <View style={styles.railHeader}>
                        <Text style={styles.section}>Pre teba</Text>
                        <Text style={styles.railMono}>AI ODPORÚČANIA</Text>
                      </View>

                      <FlatList
                        horizontal
                        data={recommended}
                        keyExtractor={(item) => item.id}
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.rail}
                        renderItem={({ item }) => (
                          <EventCard
                            event={item}
                            size="compact"
                            onPress={() => openEvent(item)}
                          />
                        )}
                      />
                    </>
                  ) : null}
            </View>
          }
          renderItem={({ item }) => (
            <View style={[styles.cardWrapper, layout.columns > 1 && styles.cardCell]}>
              <EventCard
                event={item}
                onPress={() => openEvent(item)}
                onSave={() => toggleSave(item)}
              />
            </View>
          )}
          ListFooterComponent={
            events.length > 0 ? (
              <View>
                {/* --- banners --------------------------------------------- */}
                <Pressable
                  onPress={() => router.push('/community')}
                  style={({ pressed }) => [pressed && styles.pressed]}
                >
                  <LinearGradient
                    colors={[colors.accent, colors.purple]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0.7 }}
                    style={styles.banner}
                  >
                    <Text style={styles.bannerTitle}>Ľudia ako ty</Text>
                    <Text style={styles.bannerBody}>
                      Kto má rovnaké záujmy a chodí na to isté čo ty · Blup Connect
                    </Text>
                  </LinearGradient>
                </Pressable>

                {weekly.length > 0 ? (
                  <Pressable style={styles.weekly} onPress={() => setWeeklyOpen(true)}>
                    <View style={styles.flex}>
                      <Text style={styles.weeklyTitle}>Týždenný prehľad</Text>
                      <Text style={styles.weeklyBody}>
                        {weekly.length} {weekly.length === 1 ? 'tip' : 'tipy'} na najbližšie dni
                      </Text>
                    </View>
                    <Text style={styles.weeklyGlyph}>›</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null
          }
          ListEmptyComponent={
            <EmptyState
              emoji="🌍"
              title="Zatiaľ sa tu nič nedeje"
              body="V tvojom okolí zatiaľ nikto nič nevytvoril. Môžeš byť prvý — trvá to minútu."
              actionLabel="Vytvor BLUP"
              onAction={() => {
                if (!requireAuth('Na vytvorenie eventu treba účet.', () => {})) return;
                router.push('/organizer/create');
              }}
            />
          }
        />
      )}

      {/* --- weekly sheet ----------------------------------------------------- */}
      <BottomSheet
        visible={weeklyOpen}
        onClose={() => setWeeklyOpen(false)}
        title="Na najbližšie dni"
        subtitle="Vybrané tým istým algoritmom, ktorý ti posiela týždenné zhrnutie."
        footer={
          <Button
            title="Zavrieť"
            variant="secondary"
            large
            onPress={() => setWeeklyOpen(false)}
          />
        }
      >
        {weekly.map((event) => (
          <Pressable
            key={event.id}
            style={styles.weeklyRow}
            onPress={() => {
              setWeeklyOpen(false);
              openEvent(event);
            }}
          >
            <View style={styles.flex}>
              <Text style={styles.weeklyRowTitle} numberOfLines={1}>{event.title}</Text>
              <Text style={styles.weeklyRowMeta} numberOfLines={1}>
                {event.venue_name ?? event.city ?? ''}
              </Text>
            </View>
            <Text style={styles.weeklyGlyph}>›</Text>
          </Pressable>
        ))}

        {weekly.length === 0 ? (
          <Body muted>Na najbližší týždeň zatiaľ nič nemáme.</Body>
        ) : null}
      </BottomSheet>

      {/* Creating an event used to be reachable from home only through the
          empty state — so the moment the city had one event in it, the way to
          add another disappeared. Always here now, above the tab bar. */}
      <Pressable
        onPress={() => {
          if (!requireAuth('Na vytvorenie eventu treba účet.', () => {})) return;
          router.push('/organizer/create');
        }}
        accessibilityRole="button"
        accessibilityLabel="Vytvoriť event"
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
      >
        <Text style={styles.fabGlyph}>＋</Text>
        {layout.isWide ? <Text style={styles.fabLabel}>Vytvor BLUP</Text> : null}
      </Pressable>

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.92 },

  fab: {
    position: 'absolute',
    right: spacing.gutter,
    // Clear of the tab bar on a phone; the desktop has no tab bar to clear.
    bottom: spacing.gutter,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 56,
    paddingHorizontal: 18,
    borderRadius: 28,
    backgroundColor: colors.accent,
    ...shadow.cta,
  },
  fabPressed: { opacity: 0.92, transform: [{ scale: 0.98 }] },
  fabGlyph: { color: '#FFFFFF', fontSize: 26, lineHeight: 30, fontWeight: '700' },
  fabLabel: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },

  brandRow: {
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing.sm,
    alignSelf: 'flex-start',
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing.xs,
  },
  city: { ...typography.mono, color: colors.accent },
  title: { ...typography.screenTitle, color: colors.text, marginTop: 4 },
  headerActions: { flexDirection: 'row', gap: spacing.md },

  switchRow: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.gutter,
    marginTop: spacing.xl,
  },
  switch: {
    flex: 1,
    height: 42,
    borderRadius: radius.chip,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceElevated,
  },
  switchActive: { backgroundColor: colors.accent },
  switchLabel: { ...typography.chip, fontSize: 14, color: colors.textSecondary },
  switchLabelActive: { color: '#FFFFFF' },

  mapClose: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceElevated2,
  },
  mapCloseGlyph: { color: colors.textSecondary, fontSize: 17, lineHeight: 20 },

  chipRail: { position: 'relative' },
  chipScroll: { flexGrow: 0, marginTop: spacing.lg },
  chipFade: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 32,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xxl,
  },
  switchRowWide: { maxWidth: 320, marginHorizontal: spacing.xxl },
  // The extra right padding keeps the last chip off the edge, so a rail that
  // has more to show ends in a gap rather than in a chip sliced by the screen —
  // which read as a broken layout rather than as "there is more, swipe".
  chipRow: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingLeft: spacing.gutter,
    paddingRight: spacing.gutter * 2,
  },
  chip: {
    paddingHorizontal: 15,
    paddingVertical: 11,
    borderRadius: radius.chip,
    backgroundColor: colors.surfaceElevated,
  },
  chipActive: { backgroundColor: colors.accent },
  chipLabel: { ...typography.chip, fontSize: 14, color: colors.textSecondary },
  chipLabelActive: { color: '#FFFFFF' },

  locationGate: { paddingHorizontal: spacing.gutter, marginTop: spacing.lg },

  list: { padding: spacing.gutter, paddingBottom: spacing.xxxl, flexGrow: 1 },
  cardWrapper: { marginBottom: spacing.xl },
  // In a grid the card owns its column and the row owns the gutter between
  // columns, so a card never has to know how many neighbours it has.
  cardCell: { flex: 1, minWidth: 0 },
  column: { gap: spacing.lg },
  listWide: { paddingHorizontal: spacing.xxl },

  circles: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.xl,
  },
  circlesLabel: { ...typography.meta, color: colors.textSecondary, flex: 1 },

  railHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  section: { ...typography.heading, color: colors.text },
  railMono: { ...typography.monoSm, color: colors.textMuted },
  rail: { gap: spacing.md, paddingBottom: spacing.xl },

  banner: {
    borderRadius: radius.card,
    padding: spacing.xl,
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  bannerTitle: { ...typography.heading, color: '#FFFFFF' },
  bannerBody: { ...typography.body, color: 'rgba(255,255,255,0.88)' },

  weekly: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.xl,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  weeklyTitle: { ...typography.subheading, color: colors.text },
  weeklyBody: { ...typography.metaSm, color: colors.textTertiary, marginTop: 3 },
  weeklyGlyph: { ...typography.heading, color: colors.textTertiary },

  weeklyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surfaceInput,
    borderRadius: radius.block,
    padding: spacing.lg,
  },
  weeklyRowTitle: { ...typography.rowTitle, color: colors.text },
  weeklyRowMeta: { ...typography.metaSm, color: colors.textTertiary, marginTop: 2 },

  mapWrapper: { flex: 1, marginTop: spacing.lg },
  map: { flex: 1 },
  mapCard: {
    position: 'absolute',
    left: spacing.gutter,
    right: spacing.gutter,
    bottom: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  mapThumb: {
    width: 54,
    height: 54,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mapThumbGlyph: { fontSize: 20, color: colors.accent },
  mapTitle: { ...typography.rowTitle, color: colors.text },
  mapMeta: { ...typography.metaSm, color: colors.textTertiary, marginTop: 2 },
  mapGoing: { ...typography.metaSm, color: colors.accent, marginTop: 2 },
  mapButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: radius.chip,
    backgroundColor: colors.accent,
  },
  mapButtonLabel: { ...typography.chip, color: '#FFFFFF' },
});
