import React, { useEffect, useState } from 'react';
import { EventListSkeleton, DetailSkeleton } from '@/components/Skeleton';
import {
  Alert, FlatList, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View,
} from 'react-native';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import { useLocation } from '@/hooks/useLocation';
import {
  addComment, cancelRsvp, getComments, getEvent, getEventAttendees, getFollowedAttendees,
  rsvpToEvent, saveEvent, toggleLike, unsaveEvent,
} from '@/api/events';
import { addToCart, getCart } from '@/api/cart';
import { track } from '@/marketing/tags';
import { getPeopleRecommendations, describeMatch } from '@/api/ai';
import { shareEvent } from '@/lib/share';
import { useRequireAuth } from '@/auth/useRequireAuth';
import { recordSignal } from '@/api/signals';
import { reportContent } from '@/api/admin';
import { addEventToCalendar, openDirections } from '@/maps/calendar';
import { supabase } from '@/lib/supabase';
import { joinEventConversation } from '@/api/messages';
import { createCrew, getEventCrews, joinCrew, leaveCrew } from '@/api/crews';
import { getEventRating, getMyReview, reviewEvent } from '@/api/reviews';
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
import {
  categoryFamilies, colors, familyFor, labelFor, radius, spacing, typography,
} from '@/theme';

/**
 * The basket is a web feature: on the phone the buy button opens the native
 * PaymentSheet, which prices one ticket type at a time.
 */
const HAS_CART = Platform.OS === 'web';

export default function EventDetailScreen() {
  const { requireAuth } = useRequireAuth();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile, isGuest } = useAuth();
  const location = useLocation();
  const queryClient = useQueryClient();

  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [crewName, setCrewName] = useState('');
  const [reviewBody, setReviewBody] = useState('');

  const event = useQuery({
    queryKey: ['event', id],
    queryFn: () => getEvent(id!),
    enabled: Boolean(id),
  });

  // The address someone copies from here should carry the event's name, even
  // when they arrived through the old uuid form — which still resolves.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const slug = event.data?.slug;
    if (!slug || id === slug) return;
    window.history.replaceState(null, '', `/event/${slug}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.data?.slug]);

  // The basket, so the ticket rows can say "in your basket" and the button can
  // become "go to basket" instead of adding a second time.
  const cart = useQuery({
    queryKey: ['cart', null],
    queryFn: () => getCart(null),
    enabled: HAS_CART && !isGuest,
  });

  const inCart = (ticketTypeId: string): number =>
    cart.data?.lines.find((line) => line.ticket_type_id === ticketTypeId)?.quantity ?? 0;

  const cartCount = cart.data?.event?.id === id ? (cart.data?.quantity ?? 0) : 0;

  const addTicket = async (ticketTypeId: string) => {
    if (!requireAuth('Rezervácia drží vstupenky 15 minút — musí vedieť komu.', () => {})) return;
    setError(null);
    setBusy(true);
    try {
      const updated = await addToCart(ticketTypeId, 1);
      queryClient.setQueryData(['cart', null], updated);
      setNotice('Pridané do košíka. Držíme ti ich 15 minút.');

      const line = updated.lines.find((entry) => entry.ticket_type_id === ticketTypeId);
      track('add_to_cart', {
        valueCents: line?.unit_price_cents ?? 0,
        currency: updated.currency,
        contentName: updated.event?.title,
        items: [{ id: ticketTypeId, name: line?.name, quantity: 1 }],
      });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

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

  const crews = useQuery({
    queryKey: ['event', id, 'crews'],
    queryFn: () => getEventCrews(id!),
    enabled: Boolean(id),
  });

  const rating = useQuery({
    queryKey: ['event', id, 'rating'],
    queryFn: () => getEventRating(id!),
    enabled: Boolean(id),
  });

  const myReview = useQuery({
    queryKey: ['event', id, 'my-review'],
    queryFn: () => getMyReview(id!),
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

  /**
   * "3 priatelia a 6 ľudí s tvojimi záujmami" — the two things worth knowing
   * before you decide to go alone. Friends come from the event itself (people
   * you follow who are attending); the rest are matches on shared interests.
   */
  const connectMatches = connect.data ?? [];
  // EventDetail has no friends_going — that lives on the feed item. Count the
  // matches who are already in your circles instead: same question, and it is
  // the only place this screen can answer it from.
  const connectFriends = connectMatches.filter((m) => m.mutual_follows > 0).length;
  const connectKindred = connectMatches.filter((m) => m.mutual_follows === 0).length;
  const connectCount = connectMatches.length;

  const connectSummary = [
    connectFriends > 0
      ? `${connectFriends} ${connectFriends === 1 ? 'priateľ' : connectFriends < 5 ? 'priatelia' : 'priateľov'}`
      : null,
    connectKindred > 0
      ? `${connectKindred} ${connectKindred === 1 ? 'človek' : connectKindred < 5 ? 'ľudia' : 'ľudí'} s tvojimi záujmami`
      : null,
  ].filter(Boolean).join(' a ') || 'Pozri, kto tam bude';

  // One ViewContent per event opened, not per re-render.
  const viewedTitle = event.data?.title;
  useEffect(() => {
    if (!id || !viewedTitle) return;
    track('view_event', {
      contentName: viewedTitle,
      valueCents: event.data?.price_cents ?? 0,
      items: [{ id }],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, viewedTitle]);

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

  /**
   * Refreshes this screen *and* every list the change could appear in.
   *
   * Invalidating only `['event', id]` was a real bug: unsaving an event here
   * left it sitting in Uložené until a hard refresh, because that list is
   * keyed `['events', 'saved']` and nothing told it anything had happened.
   * The `['events']` prefix covers saved, "idem na", the home feed, the deck
   * and the organizer's own list in one call.
   */
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['event', id] }),
    queryClient.invalidateQueries({ queryKey: ['events'] }),
  ]);

  const data = event.data;

  const handleRsvp = (status: 'going' | 'interested') =>
    requireAuth(
      status === 'going'
        ? 'Aby sme vedeli, že ideš, a organizátor s tebou rátal.'
        : 'Uložíme si, že ťa to zaujíma, a dáme ti vedieť pred eventom.',
      () => void rsvp(status),
    );

  const rsvp = async (status: 'going' | 'interested') => {
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

  const handleSave = () =>
    requireAuth('Uložené eventy sú v tvojom profile, takže potrebuješ účet.', () => void save());

  const save = async () => {
    setError(null);
    try {
      if (data?.is_saved) await unsaveEvent(id!);
      else await saveEvent(id!);
      await refresh();
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  const handleLike = () =>
    requireAuth('Páči sa mi to je pripnuté k účtu.', () => void like());

  const like = async () => {
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
      const result = await shareEvent({
        id: data.id,
        title: data.title,
        whenLabel: formatEventDateLong(data.start_at),
      });
      if (result.copied) setNotice('Odkaz je v schránke — stačí ho vložiť.');
      if (result.shared) void recordSignal(data.id, 'share');
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
    Alert.prompt?.('Nahlásiť event', 'Čo je s ním zle?', async (reason) => {
      if (!reason?.trim()) return;
      try {
        await reportContent({ targetType: 'event', targetId: id!, reason: reason.trim() });
        setNotice('Nahlásené. Naši moderátori sa na to pozrú.');
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

  if (event.isLoading) return <View style={styles.loading}><DetailSkeleton /></View>;

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

  const toggleCrew = async (crewId: string, joined: boolean) => {
    setError(null);
    try {
      if (joined) await leaveCrew(crewId);
      else await joinCrew(crewId);
      await crews.refetch();
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  const startCrew = async () => {
    const name = crewName.trim();
    if (!name) return;

    setError(null);
    setBusy(true);
    try {
      await createCrew({ eventId: data.id, name });
      setCrewName('');
      await crews.refetch();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const submitReview = async (value: number) => {
    setError(null);
    try {
      await reviewEvent(data.id, value, reviewBody);
      setReviewBody('');
      await Promise.all([rating.refetch(), myReview.refetch()]);
      setNotice('Ďakujeme za hodnotenie.');
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  const openGroupChat = async () => {
    setError(null);
    try {
      const conversationId = await joinEventConversation(data.id);
      router.push(`/chat/${conversationId}`);
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {/* --- hero ----------------------------------------------------------- */}
      <GradientCover
        uri={data.cover_image_url}
        category={data.category}
        height={300}
        showPlaceholderLabel={false}
        overlay
      >
        <View style={styles.heroTop}>
          <IconButton glyph="‹" tone="overlay" onPress={() => router.back()} />
          <Pressable
            onPress={handleSave}
            style={[styles.savePill, data.is_saved && styles.savePillActive]}
          >
            <Text style={styles.savePillLabel}>
              {data.is_saved ? '★  Blupnuté' : '☆  Blup'}
            </Text>
          </Pressable>
        </View>

        <View style={styles.heroBottom}>
          <View style={styles.heroChips}>
            <Chip label={categoryFamilies[familyFor(data.category)].label} onCover />
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
        {/* An event belongs to an organization, not to a person. Where one hosts,
            it is its name, its logo and its page — the founder's own name and
            face stay out of it, and live only in the verification record and on
            the ticket, where the law wants the legal entity anyway. */}
        <Pressable
          style={styles.host}
          onPress={() =>
            data.organization
              ? router.push(`/org/${data.organization.id}`)
              : router.push(`/user/${data.creator_id}`)
          }
        >
          <Avatar
            url={data.organization?.logo_url ?? data.creator?.avatar_url}
            name={data.organization?.name ?? data.creator?.display_name}
            size={40}
            square={Boolean(data.organization)}
          />
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

        {/* --- group chat ---------------------------------------------------- */}
        {data.my_rsvp === 'going' || data.my_rsvp === 'checked_in' || isOwner ? (
          <Pressable
            style={({ pressed }) => [styles.chatCard, pressed && styles.chatCardPressed]}
            onPress={() =>
              requireAuth('Do chatu eventu treba účet — inak nikto nevie, kto píše.', () =>
                void openGroupChat())
            }
          >
            <View style={styles.chatIcon}><Text style={styles.chatGlyph}>✉</Text></View>
            <View style={styles.flex}>
              <Text style={styles.hostName}>Chat eventu</Text>
              <Caption>Dohodni sa, s kým prídeš, opýtaj sa na parkovanie a nezmeškaj, čo píše organizátor.</Caption>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ) : null}

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
                      {inCart(ticket.id) > 0 ? ` · ${inCart(ticket.id)} v košíku` : ''}
                    </Caption>
                  </View>
                  <Text style={styles.ticketPrice}>
                    {formatPrice(ticket.price_cents, ticket.currency)}
                  </Text>
                  {HAS_CART && !soldOut ? (
                    <Button
                      title="Pridať"
                      variant="secondary"
                      compact
                      disabled={busy}
                      onPress={() => void addTicket(ticket.id)}
                    />
                  ) : null}
                </View>
              );
            })}

            <Button
              title={cartCount > 0 ? `Do košíka (${cartCount})` : 'Kúpiť'}
              onPress={() =>
                router.push(cartCount > 0 ? '/cart' : `/event/checkout/${data.id}`)
              }
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

        {/* --- gallery ------------------------------------------------------ */}
        {(data.gallery ?? []).length > 0 || isOwner ? (
          <>
            <SectionHeader
              title={`Fotky · ${(data.gallery ?? []).length}`}
              action={isOwner ? 'Spravovať' : undefined}
              onAction={() => router.push(`/event/photos/${data.id}`)}
            />

            {(data.gallery ?? []).length === 0 ? (
              <Pressable
                style={styles.galleryEmpty}
                onPress={() => router.push(`/event/photos/${data.id}`)}
              >
                <Text style={styles.galleryEmptyGlyph}>＋</Text>
                <Caption>Pridaj titulnú fotku a fotky z miesta</Caption>
              </Pressable>
            ) : (
              <FlatList
                horizontal
                data={data.gallery ?? []}
                keyExtractor={(item) => item.id}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.galleryRail}
                renderItem={({ item }) => (
                  <Pressable onPress={() => router.push(`/event/photos/${data.id}`)}>
                    <Image source={{ uri: item.url }} style={styles.galleryImage} contentFit="cover" />
                  </Pressable>
                )}
              />
            )}
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

        {/* --- seating -------------------------------------------------------- */}
        {/* Only for an event that has a plan, which is almost none of them —
            everything else keeps the plain ticket list above. */}
        {/* The organizer's way back in, on their own event. */}
        {isOwner && data.venue_map_id ? (
          <Pressable
            style={styles.connectCard}
            onPress={() => router.push(`/organizer/plan/${data.id}`)}
            accessibilityRole="button"
          >
            <View style={styles.connectIcon}>
              <Text style={styles.connectGlyph}>✎</Text>
            </View>
            <View style={styles.flex}>
              <Text style={styles.hostName}>Upraviť plán sály</Text>
              <Caption style={styles.matchReason}>Sektory, farby a číslované rady</Caption>
            </View>
            <View style={styles.connectCta}>
              <Text style={styles.connectCtaLabel}>Otvoriť</Text>
            </View>
          </Pressable>
        ) : null}

        {data.venue_map_id ? (
          <Pressable
            style={styles.connectCard}
            onPress={() => router.push(`/event/seats/${data.id}`)}
            accessibilityRole="button"
          >
            <View style={styles.connectIcon}>
              <Text style={styles.connectGlyph}>▦</Text>
            </View>
            <View style={styles.flex}>
              <Text style={styles.hostName}>Vybrať si miesto</Text>
              <Caption style={styles.matchReason}>Plán sály so sektormi a sedadlami</Caption>
            </View>
            <View style={styles.connectCta}>
              <Text style={styles.connectCtaLabel}>Otvoriť</Text>
            </View>
          </Pressable>
        ) : null}

        {/* --- BLUP Connect ------------------------------------------------- */}
        {/* One line rather than five rows. The list sat unnamed halfway down
            the page and only appeared when it had five people to show; the
            summary is visible whenever there is anybody at all, and the screen
            behind it has room to say why each of them is on it. */}
        {connectCount > 0 ? (
          <Pressable
            style={styles.connectCard}
            onPress={() => router.push(`/connect/${data.id}`)}
            accessibilityRole="button"
          >
            <View style={styles.connectIcon}>
              <Text style={styles.connectGlyph}>⇄</Text>
            </View>
            <View style={styles.flex}>
              <Text style={styles.hostName}>Blup Connect</Text>
              <Caption style={styles.matchReason}>{connectSummary}</Caption>
            </View>
            <View style={styles.connectCta}>
              <Text style={styles.connectCtaLabel}>Zobraziť</Text>
            </View>
          </Pressable>
        ) : null}

        {/* --- crews --------------------------------------------------------- */}
        {!isPast && data.status !== 'cancelled' ? (
          <>
            <View style={styles.crewHeader}>
              <SectionHeader title="Spoločné plány" />
            </View>
            <Caption style={styles.crewHint}>
              Partia, ktorá ide spolu. Založ si vlastnú alebo sa pridaj k existujúcej.
            </Caption>

            {(crews.data ?? []).map((crew) => {
              const full = (crew.member_count ?? 0) >= crew.max_size;

              return (
                <View key={crew.id} style={styles.crewRow}>
                  <View style={styles.flex}>
                    <Text style={styles.hostName}>{crew.name}</Text>
                    <Caption>
                      {crew.member_count}/{crew.max_size} ľudí
                      {full && !crew.joined ? ' · plná' : ''}
                    </Caption>
                  </View>

                  <Button
                    title={crew.joined ? 'Odísť' : 'Pridať sa'}
                    variant={crew.joined ? 'ghost' : 'teal'}
                    compact
                    disabled={!crew.joined && full}
                    onPress={() => toggleCrew(crew.id, Boolean(crew.joined))}
                  />
                </View>
              );
            })}

            <View style={styles.crewComposer}>
              <Input
                value={crewName}
                onChangeText={setCrewName}
                placeholder="Napr. Ideme vlakom o 18:00"
                maxLength={60}
                style={styles.crewInput}
              />
              <Button
                title="Založiť partiu"
                variant="teal"
                compact
                onPress={startCrew}
                loading={busy}
                disabled={!crewName.trim()}
                style={styles.crewSubmit}
              />
            </View>
          </>
        ) : null}

        {/* --- rating -------------------------------------------------------- */}
        {isPast ? (
          <>
            <SectionHeader
              title={
                (rating.data?.count ?? 0) > 0
                  ? `Hodnotenie · ${rating.data?.average.toFixed(1)} ★ (${rating.data?.count})`
                  : 'Hodnotenie'
              }
            />

            {data.my_rsvp === 'going' || data.my_rsvp === 'checked_in' ? (
              <View style={styles.reviewBox}>
                <Caption>
                  {myReview.data
                    ? 'Tvoje hodnotenie — kliknutím ho zmeníš.'
                    : 'Bol si tam. Ako to bolo?'}
                </Caption>

                <View style={styles.starRow}>
                  {[1, 2, 3, 4, 5].map((value) => (
                    <Pressable key={value} onPress={() => submitReview(value)} hitSlop={6}>
                      <Text
                        style={[
                          styles.star,
                          (myReview.data?.rating ?? 0) >= value && styles.starActive,
                        ]}
                      >
                        {(myReview.data?.rating ?? 0) >= value ? '★' : '☆'}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                <Input
                  value={reviewBody}
                  onChangeText={setReviewBody}
                  placeholder="Napíš pár slov (nepovinné)"
                  multiline
                  maxLength={2000}
                  style={styles.reviewInput}
                />
                <Button
                  title="Uložiť hodnotenie"
                  variant="secondary"
                  compact
                  disabled={!myReview.data && !reviewBody.trim()}
                  onPress={() => submitReview(myReview.data?.rating ?? 5)}
                />
              </View>
            ) : (rating.data?.count ?? 0) === 0 ? (
              <Body muted>Zatiaľ bez hodnotení. Hodnotiť môžu len tí, čo tam boli.</Body>
            ) : null}
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
  galleryRail: { gap: spacing.sm, paddingVertical: spacing.xs },
  galleryImage: {
    width: 140,
    height: 105,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceElevated,
  },
  galleryEmpty: {
    height: 105,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  galleryEmptyGlyph: { fontSize: 24, color: colors.textTertiary },

  chatCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chatCardPressed: { backgroundColor: colors.surfacePressed },
  chatIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatGlyph: { fontSize: 17, color: colors.accentText },
  chevron: { ...typography.heading, color: colors.textTertiary },

  // The whole section is capped and centred like the actions above it —
  // full-column-width rows of two short words read as a table, not a list.
  crewHeader: { width: '100%', maxWidth: 520, alignSelf: 'center' },
  crewHint: { marginBottom: spacing.sm, textAlign: 'center', alignSelf: 'center', maxWidth: 520 },
  crewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  // Stacked rather than side by side: at the width the input needs to hold
  // "Ideme vlakom o 18:00", a button beside it squeezed both.
  crewComposer: { width: '100%', maxWidth: 520, alignSelf: 'center' },
  crewInput: { marginBottom: spacing.sm },
  crewSubmit: { alignSelf: 'center' },

  reviewBox: {
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  starRow: { flexDirection: 'row', gap: spacing.xs },
  star: { fontSize: 30, color: colors.textTertiary },
  starActive: { color: colors.warning },
  reviewInput: { minHeight: 70, textAlignVertical: 'top', marginBottom: 0 },

  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: spacing.xxxl },
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },


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
  savePillActive: { backgroundColor: colors.accent },
  savePillLabel: { ...typography.chip, color: colors.text },
  heroBottom: { padding: spacing.lg, gap: spacing.sm },
  heroChips: { flexDirection: 'row', gap: spacing.sm },
  heroTitle: { ...typography.eventTitle, color: '#FFFFFF' },

  body: {
    padding: spacing.gutter,
    marginTop: -spacing.xl,
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    gap: spacing.md,
  },
  infoRow: { flexDirection: 'row', gap: spacing.md },


  host: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.lg },
  hostName: { ...typography.bodyStrong, color: colors.text },

  // Capped and centred: at full column width on a desktop these two became a
  // pair of banners rather than buttons, and sat far left of everything else.
  loading: { flex: 1, backgroundColor: colors.background, padding: spacing.gutter },
  connectCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    marginTop: spacing.md,
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
  },
  connectIcon: {
    width: 44, height: 44, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.accentSoft,
  },
  connectGlyph: { color: colors.accent, fontSize: 20 },
  connectCta: {
    paddingHorizontal: spacing.md, paddingVertical: 9,
    borderRadius: radius.sm, backgroundColor: colors.tealSoft,
  },
  connectCtaLabel: { color: colors.teal, fontWeight: '700', fontSize: 13 },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
  },
  iconRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
    flexWrap: 'wrap',
    justifyContent: 'center',
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
  },
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
