import React, { useEffect, useState } from 'react';
import {
  Alert, FlatList, Pressable, ScrollView, Share, StyleSheet, Text, View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import { useLocation } from '@/hooks/useLocation';
import {
  addComment, cancelRsvp, getComments, getEvent, getEventAttendees, getFollowedAttendees,
  rsvpToEvent, saveEvent, toggleLike, unsaveEvent,
} from '@/api/events';
import { getPeopleRecommendations, describeMatch } from '@/api/ai';
import { recordSignal } from '@/api/signals';
import { reportContent } from '@/api/admin';
import { addEventToCalendar, openDirections } from '@/maps/calendar';
import { supabase } from '@/lib/supabase';
import { messageFor } from '@/lib/errors';
import {
  estimateWalkingTime, formatCount, formatDistanceFromYou, formatEventDate,
  formatEventDateLong, formatPrice,
} from '@/lib/format';
import { EventMap } from '@/components/EventMap';
import { GradientCover } from '@/components/GradientCover';
import {
  Avatar, Badge, Body, Button, Caption, Chip, Divider, ErrorState, IconButton, InfoBox, Input,
  LoadingState, Mono, Notice, SectionHeader,
} from '@/components/ui';
import { colors, labelFor, radius, spacing, typography } from '@/theme';

export default function EventDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useAuth();
  const location = useLocation();
  const queryClient = useQueryClient();

  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const event = useQuery({
    queryKey: ['event', id],
    queryFn: () => getEvent(id!),
    enabled: Boolean(id),
  });

  const attendees = useQuery({
    queryKey: ['event', id, 'attendees'],
    queryFn: () => getEventAttendees(id!),
    enabled: Boolean(id),
  });

  const followedGoing = useQuery({
    queryKey: ['event', id, 'followed'],
    queryFn: () => getFollowedAttendees(id!),
    enabled: Boolean(id),
  });

  const comments = useQuery({
    queryKey: ['event', id, 'comments'],
    queryFn: () => getComments(id!),
    enabled: Boolean(id),
  });

  const connect = useQuery({
    queryKey: ['event', id, 'connect'],
    queryFn: () => getPeopleRecommendations({ eventId: id, limit: 10 }),
    enabled: Boolean(id),
  });

  // Live attendee counts while the screen is open.
  useEffect(() => {
    if (!id) return;

    const channel = supabase
      .channel(`event-${id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'event_attendees', filter: `event_id=eq.${id}` },
        () => {
          void queryClient.invalidateQueries({ queryKey: ['event', id] });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [id, queryClient]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['event', id] });

  const data = event.data;

  const handleRsvp = async (status: 'going' | 'interested') => {
    setError(null);
    setBusy(true);
    try {
      if (data?.my_rsvp === status) {
        await cancelRsvp(id!);
      } else {
        await rsvpToEvent(id!, status);
      }
      await refresh();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    setError(null);
    try {
      if (data?.is_saved) await unsaveEvent(id!);
      else await saveEvent(id!);
      await refresh();
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  const handleLike = async () => {
    if (!data) return;
    try {
      await toggleLike(id!, !data.is_liked);
      await refresh();
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  const handleShare = async () => {
    if (!data) return;
    try {
      await Share.share({
        message: `${data.title} · ${formatEventDateLong(data.start_at)}\n\nSee it on BLUP: blup://event/${data.id}`,
      });
      void recordSignal(data.id, 'share');
    } catch {
      /* user dismissed */
    }
  };

  const handleCalendar = async () => {
    if (!data) return;
    const result = await addEventToCalendar(data);
    setNotice(result.message);
  };

  const handleReport = () => {
    Alert.prompt?.('Report this event', 'What is wrong with it?', async (reason) => {
      if (!reason?.trim()) return;
      try {
        await reportContent({ targetType: 'event', targetId: id!, reason: reason.trim() });
        setNotice('Reported. Our moderators will take a look.');
      } catch (caught) {
        setError(messageFor(caught));
      }
    });
  };

  const postComment = async () => {
    if (!comment.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addComment(id!, comment);
      setComment('');
      await comments.refetch();
      await refresh();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  if (event.isLoading) return <LoadingState label="Načítavam event…" />;

  if (event.isError || !data) {
    return (
      <ErrorState
        title="Event nie je dostupný"
        message={
          event.error
            ? messageFor(event.error)
            : 'Event mohol byť odstránený, alebo ho nemáš právo vidieť.'
        }
        onRetry={() => void event.refetch()}
      />
    );
  }

  const distance = location.coords
    ? formatDistanceFromYou(
        haversine(location.coords.latitude, location.coords.longitude, data.latitude, data.longitude),
      )
    : null;

  const walk = location.coords
    ? estimateWalkingTime(
        haversine(location.coords.latitude, location.coords.longitude, data.latitude, data.longitude),
      )
    : null;

  const isOwner = data.creator_id === profile?.id;
  const isFull = Boolean(data.capacity && data.attendee_count >= data.capacity);
  const hasTickets = data.ticket_types.length > 0;
  const isPast = new Date(data.start_at).getTime() < Date.now();

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {/* --- hero ----------------------------------------------------------- */}
      <GradientCover uri={data.cover_image_url} seed={data.id} height={330} showPlaceholderLabel={false}>
        <View style={styles.heroTop}>
          <IconButton glyph="‹" tone="overlay" onPress={() => router.back()} />
          <Pressable onPress={handleSave} style={styles.savePill}>
            <Text style={styles.savePillLabel}>{data.is_saved ? '★' : '☆'}  Blup</Text>
          </Pressable>
        </View>

        <View style={styles.heroBottom}>
          <View style={styles.heroChips}>
            <Chip label={labelFor(data.category)} onCover />
            {data.attendee_count > 20 ? <Chip label="Frčí" onCover /> : null}
          </View>
          <Text style={styles.heroTitle}>{data.title}</Text>
        </View>
      </GradientCover>

      <View style={styles.body}>
        {error ? <Notice tone="danger" title="Niečo sa pokazilo" body={error} /> : null}
        {notice ? <Notice tone="accent" title="Hotovo" body={notice} /> : null}

        {data.status === 'cancelled' ? (
          <Notice tone="danger" title="Event bol zrušený" body="Organizátor ho odvolal." />
        ) : null}

        <View style={styles.infoRow}>
          <InfoBox label="Kedy" value={formatEventDate(data.start_at)} />
          <InfoBox label="Kde" value={data.venue_name ?? data.city ?? 'Podľa mapy'} />
        </View>

        {/* --- host --------------------------------------------------------- */}
        <Pressable style={styles.host} onPress={() => router.push(`/user/${data.creator_id}`)}>
          <Avatar url={data.creator?.avatar_url} name={data.creator?.display_name} size={40} />
          <View style={styles.flex}>
            <Caption>Organizuje</Caption>
            <Text style={styles.hostName}>
              {data.organization?.name ?? data.creator?.display_name ?? 'Niekto na BLUPe'}
            </Text>
          </View>
        </Pressable>

        {/* --- actions ------------------------------------------------------ */}
        <View style={styles.actionRow}>
          <Button
            title={data.my_rsvp === 'going' ? '✓ Idem' : 'Idem'}
            variant={data.my_rsvp === 'going' ? 'secondary' : 'primary'}
            onPress={() => handleRsvp('going')}
            loading={busy}
            disabled={isPast || (isFull && data.my_rsvp !== 'going') || data.status === 'cancelled'}
            style={styles.flex}
          />
          <Button
            title={data.my_rsvp === 'interested' ? '✓ Zaujíma ma' : 'Zaujíma ma'}
            variant="secondary"
            onPress={() => handleRsvp('interested')}
            disabled={isPast}
            style={styles.flex}
          />
        </View>

        <View style={styles.iconRow}>
          <ActionPill label={data.is_saved ? '★ Uložené' : '☆ Uložiť'} onPress={handleSave} />
          <ActionPill label={`♥ ${formatCount(data.like_count)}`} onPress={handleLike} />
          <ActionPill label="↗ Zdieľať" onPress={handleShare} />
          <ActionPill label="📅 Kalendár" onPress={handleCalendar} />
        </View>

        {/* --- tickets ------------------------------------------------------ */}
        {hasTickets && !isPast ? (
          <>
            <SectionHeader title="Vstupenky" />
            {data.ticket_types.map((ticket) => {
              const remaining = ticket.quantity_total - ticket.quantity_sold;
              const soldOut = remaining <= 0;

              return (
                <View key={ticket.id} style={styles.ticketRow}>
                  <View style={styles.flex}>
                    <Text style={styles.ticketName}>{ticket.name}</Text>
                    {ticket.description ? <Caption>{ticket.description}</Caption> : null}
                    <Caption style={soldOut ? styles.soldOut : undefined}>
                      {soldOut ? 'Vypredané' : `zostáva ${remaining}`}
                    </Caption>
                  </View>
                  <Text style={styles.ticketPrice}>
                    {formatPrice(ticket.price_cents, ticket.currency)}
                  </Text>
                </View>
              );
            })}

            <Button
              title="Kúpiť lístok"
              onPress={() => router.push(`/event/checkout/${data.id}`)}
              disabled={data.ticket_types.every((t) => t.quantity_sold >= t.quantity_total)}
              style={styles.ticketButton}
            />
          </>
        ) : null}

        {/* --- about -------------------------------------------------------- */}
        {data.description ? (
          <>
            <SectionHeader title="O evente" />
            <Body>{data.description}</Body>
          </>
        ) : null}

        {/* --- location ----------------------------------------------------- */}
        <SectionHeader title="Kde to je" />
        <View style={styles.mapWrapper}>
          <EventMap
            events={[{ ...data, friends_going: 0, is_saved: false, is_attending: false } as never]}
            userLocation={location.coords}
            interactive={false}
            style={styles.map}
          />
        </View>

        <View style={styles.locationInfo}>
          <View style={styles.flex}>
            {data.venue_name ? <Text style={styles.venue}>{data.venue_name}</Text> : null}
            {data.address ? <Caption>{data.address}</Caption> : null}
            {distance ? (
              <Caption style={styles.distance}>
                {distance}{walk ? ` · ${walk}` : ''}
              </Caption>
            ) : (
              <Caption>Zapni polohu a uvidíš, ako ďaleko to je.</Caption>
            )}
          </View>
          <Button title="Navigovať" variant="secondary" compact onPress={() => openDirections(data)} />
        </View>

        {/* --- who is going ------------------------------------------------- */}
        <SectionHeader
          title={`Kto ide · ${formatCount(data.attendee_count)}`}
          action={attendees.data && attendees.data.length > 6 ? 'Zobraziť všetkých' : undefined}
          onAction={() => router.push(`/event/attendees/${data.id}`)}
        />

        {(followedGoing.data ?? []).length > 0 ? (
          <Notice
            tone="accent"
            title={`${followedGoing.data!.length} z tvojich kruhov ide`}
            body={followedGoing
              .data!.slice(0, 3)
              .map((attendee) => attendee.profile?.display_name ?? 'Niekto')
              .join(', ')}
          />
        ) : null}

        {(attendees.data ?? []).length === 0 ? (
          <Body muted>Zatiaľ nikto — buď prvý, kto povie, že ide.</Body>
        ) : (
          <FlatList
            horizontal
            data={attendees.data ?? []}
            keyExtractor={(item) => item.user_id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.avatarRail}
            renderItem={({ item }) => (
              <Pressable
                style={styles.attendee}
                onPress={() => router.push(`/user/${item.user_id}`)}
              >
                <Avatar url={item.profile?.avatar_url} name={item.profile?.display_name} size={52} />
                <Caption numberOfLines={1} style={styles.attendeeName}>
                  {item.profile?.display_name?.split(' ')[0] ?? '—'}
                </Caption>
              </Pressable>
            )}
          />
        )}

        {/* --- BLUP Connect ------------------------------------------------- */}
        {(connect.data ?? []).length > 0 ? (
          <>
            <SectionHeader title="Blup Connect" />
            <Caption style={styles.connectHint}>Ľudia odtiaľto, s ktorými si asi sadneš.</Caption>
            {(connect.data ?? []).slice(0, 5).map((match) => (
              <Pressable
                key={match.user_id}
                style={styles.connectRow}
                onPress={() => router.push(`/user/${match.user_id}`)}
              >
                <Avatar url={match.avatar_url} name={match.display_name} size={44} />
                <View style={styles.flex}>
                  <Text style={styles.hostName}>{match.display_name ?? match.username}</Text>
                  <Caption style={styles.matchReason}>{describeMatch(match)}</Caption>
                </View>
                <Badge tone="accent" label={`${Math.round(match.score * 100)}%`} />
              </Pressable>
            ))}
          </>
        ) : null}

        {/* --- comments ----------------------------------------------------- */}
        <SectionHeader title={`Komentáre · ${formatCount(data.comment_count)}`} />

        <View style={styles.commentInput}>
          <Input
            value={comment}
            onChangeText={setComment}
            placeholder="Opýtaj sa alebo pozdrav"
            multiline
            maxLength={1000}
            style={styles.commentField}
          />
          <Button title="Poslať" compact onPress={postComment} loading={busy} disabled={!comment.trim()} />
        </View>

        {(comments.data ?? []).length === 0 ? (
          <Body muted>Zatiaľ žiadne komentáre.</Body>
        ) : (
          (comments.data ?? []).map((item) => (
            <View key={item.id} style={styles.comment}>
              <Avatar url={item.author?.avatar_url} name={item.author?.display_name} size={34} />
              <View style={styles.flex}>
                <Text style={styles.commentAuthor}>
                  {item.author?.display_name ?? item.author?.username ?? 'Niekto'}
                </Text>
                <Body>{item.body}</Body>
              </View>
            </View>
          ))
        )}

        <Divider />

        {isOwner ? (
          <View style={styles.ownerActions}>
            <Button
              title="Upraviť event"
              variant="secondary"
              onPress={() => router.push(`/event/edit/${data.id}`)}
            />
            {!data.is_free ? (
              <Button
                title="Organizátor"
                variant="secondary"
                onPress={() => router.push(`/organizer/analytics/${data.id}`)}
              />
            ) : null}
          </View>
        ) : (
          <Button title="Nahlásiť event" variant="ghost" onPress={handleReport} />
        )}
      </View>
    </ScrollView>
  );
}

function ActionPill({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
    >
      <Text style={styles.iconButtonLabel}>{label}</Text>
    </Pressable>
  );
}

/** Local distance so the detail screen does not need another round trip. */
function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: spacing.xxxl },
  flex: { flex: 1 },


  heroTop: {
    position: 'absolute',
    top: spacing.xxl,
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  savePill: {
    backgroundColor: colors.overlay,
    paddingHorizontal: spacing.lg,
    paddingVertical: 11,
    borderRadius: radius.md,
  },
  savePillLabel: { ...typography.bodyStrong, color: colors.text },
  heroBottom: { padding: spacing.lg, gap: spacing.sm },
  heroChips: { flexDirection: 'row', gap: spacing.sm },
  heroTitle: { ...typography.title, color: '#FFFFFF' },

  body: {
    padding: spacing.lg,
    marginTop: -spacing.xl,
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    gap: spacing.md,
  },
  infoRow: { flexDirection: 'row', gap: spacing.md },


  host: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.lg },
  hostName: { ...typography.bodyStrong, color: colors.text },

  actionRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  iconRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, flexWrap: 'wrap' },
  iconButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  iconButtonPressed: { backgroundColor: colors.surfacePressed },
  iconButtonLabel: { ...typography.caption, color: colors.text },

  ticketRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  ticketName: { ...typography.bodyStrong, color: colors.text },
  ticketPrice: { ...typography.subheading, color: colors.text },
  soldOut: { color: colors.danger },
  ticketButton: { marginTop: spacing.lg },

  mapWrapper: { height: 180, borderRadius: radius.lg, overflow: 'hidden' },
  map: { flex: 1 },
  locationInfo: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.md },
  venue: { ...typography.bodyStrong, color: colors.text },
  distance: { color: colors.accent, marginTop: 2 },

  avatarRail: { gap: spacing.md, paddingVertical: spacing.sm },
  attendee: { alignItems: 'center', width: 60, gap: spacing.xs },
  attendeeName: { textAlign: 'center' },

  connectHint: { marginBottom: spacing.md },
  connectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  matchReason: { color: colors.accent },

  commentInput: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  commentField: { flex: 1, marginBottom: 0, minHeight: 44 },
  comment: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg },
  commentAuthor: { ...typography.caption, color: colors.textSecondary, marginBottom: 2 },

  ownerActions: { gap: spacing.sm },
});
