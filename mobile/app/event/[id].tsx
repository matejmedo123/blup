import React, { useEffect, useRef, useState } from 'react';
import { EventListSkeleton, DetailSkeleton } from '@/components/Skeleton';
import {
  FlatList, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View,
} from 'react-native';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import { useLocation } from '@/hooks/useLocation';
import {
  addComment, cancelRsvp, claimEvent, eventHasEnded, getComments, getEvent,
  getEventAttendees, getFollowedAttendees, rsvpToEvent, saveEvent, toggleLike, unsaveEvent,
} from '@/api/events';
import { openExternal } from '@/lib/external';
import { addToCart, getCart } from '@/api/cart';
import { track } from '@/marketing/tags';
import { getPeopleRecommendations, describeMatch } from '@/api/ai';
import { shareEvent } from '@/lib/share';
import { useRequireAuth } from '@/auth/useRequireAuth';
import { recordSignal } from '@/api/signals';
import { reportContent } from '@/api/admin';
import { addEventToCalendar, openDirections } from '@/maps/calendar';
import { subscribeToTable } from '@/lib/realtime';
import { joinEventConversation } from '@/api/messages';
import { getMyOrganizations } from '@/api/organizations';
import { createCrew, getEventCrews, joinCrew, leaveCrew } from '@/api/crews';
import { getEventRating, getMyReview, reviewEvent } from '@/api/reviews';
import { useDialog } from '@/components/Dialog';
import { enterSubmits } from '@/lib/keyboard';
import { messageFor } from '@/lib/errors';
import {
  estimateWalkingTime, formatCount, formatDistanceFromYou, formatEventDate,
  formatEventDateLong, formatPrice, vatIncludedLabel,
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

/**
 * Where a ticket can be bought without an account.
 *
 * The browser only. In the app there is a sign-in screen in front of this
 * anyway, and an anonymous purchase flow there is a different conversation with
 * Apple.
 */
const GUEST_CHECKOUT = Platform.OS === 'web';

/** The address bar carries either a slug or a uuid; only one of them is an id. */
const UUID_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function EventDetailScreen() {
  const { requireAuth } = useRequireAuth();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile, isGuest } = useAuth();
  const location = useLocation();
  const queryClient = useQueryClient();

  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useDialog();
  const [notice, setNotice] = useState<string | null>(null);
  const [crewName, setCrewName] = useState('');
  const [reviewBody, setReviewBody] = useState('');
  const [claimed, setClaimed] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);

  const event = useQuery({
    queryKey: ['event', id],
    queryFn: () => getEvent(id!),
    enabled: Boolean(id),
  });

  /**
   * The event's real id.
   *
   * `id` here is whatever is in the address bar, and since links carry the
   * readable slug that is usually *not* a uuid. Everything else on this screen
   * — comments, RSVP, saving, crews, ratings — writes rows keyed by uuid, so
   * they all have to use this one. Passing the slug to them failed silently:
   * the lists came back empty and posting a comment errored at the top of a
   * page the reader was at the bottom of.
   */
  const eventId = event.data?.id ?? (id && UUID_REF.test(id) ? id : null);


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

  /**
   * The one buy button under the ticket list.
   *
   * Everything goes through the basket: it is the same screen as the checkout
   * was, and having two of them meant "Kúpiť" and "Do košíka" led to different
   * places for the same purchase. With something already reserved this just
   * opens the basket; with nothing, it puts the cheapest ticket still on sale
   * in there first, so the button does what it says rather than opening an
   * empty basket.
   */
  const buy = async () => {
    if (!data) return;

    // A guest has no basket — cart_items belong to an account — so sending them
    // through it only produced "you need to sign in", and the checkout screen
    // that knows how to sell to somebody without an account sat behind that
    // wall, unreachable. They go straight to it instead.
    if (isGuest && GUEST_CHECKOUT) {
      router.push(`/event/checkout/${data.id}`);
      return;
    }

    if (cartCount > 0 || !HAS_CART) {
      router.push(HAS_CART ? '/cart' : `/event/checkout/${data.id}`);
      return;
    }

    const cheapest = [...data.ticket_types]
      .filter((ticket) => ticket.quantity_total - ticket.quantity_sold > 0)
      .sort((a, b) => a.price_cents - b.price_cents)[0];

    if (!cheapest) return;

    // Only leave the page if the ticket is really reserved — otherwise the
    // basket opens empty and the reason it failed stays behind on this screen.
    if (await addTicket(cheapest.id)) router.push('/cart');
  };

  /** True when the ticket actually made it into the basket. */
  const addTicket = async (ticketTypeId: string): Promise<boolean> => {
    if (!requireAuth(
      'Rezervácia drží vstupenky 15 minút — musí vedieť komu.',
      () => {},
      // Buying is the one thing here that genuinely needs no account: a ticket
      // needs a name, an address and a town, which is what the checkout asks
      // for. The sheet offers that instead of only a wall.
      isGuest && GUEST_CHECKOUT && data
        ? {
            href: `/event/checkout/${data.id}`,
            label: 'Pokračovať ako hosť',
            note: 'Bez účtu to ide tiež — stačí meno, e-mail a mesto. Vstupenku ti pošleme '
              + 'e-mailom a pri vstupe funguje rovnako. Účet ti ju len odloží na jedno miesto.',
          }
        : null,
    )) {
      return false;
    }
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
      return true;
    } catch (caught) {
      setError(messageFor(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const attendees = useQuery({
    queryKey: ['event', id, 'attendees'],
    queryFn: () => getEventAttendees(eventId!),
    enabled: Boolean(eventId),
  });

  const followedGoing = useQuery({
    queryKey: ['event', id, 'followed'],
    queryFn: () => getFollowedAttendees(eventId!),
    enabled: Boolean(eventId),
  });

  const crews = useQuery({
    queryKey: ['event', id, 'crews'],
    queryFn: () => getEventCrews(eventId!),
    enabled: Boolean(eventId),
  });

  const rating = useQuery({
    queryKey: ['event', id, 'rating'],
    queryFn: () => getEventRating(eventId!),
    enabled: Boolean(eventId),
  });

  const myReview = useQuery({
    queryKey: ['event', id, 'my-review'],
    queryFn: () => getMyReview(eventId!),
    enabled: Boolean(eventId),
  });

  const comments = useQuery({
    queryKey: ['event', id, 'comments'],
    queryFn: () => getComments(eventId!),
    enabled: Boolean(eventId),
  });

  const connect = useQuery({
    queryKey: ['event', id, 'connect'],
    queryFn: () => getPeopleRecommendations({ eventId: eventId!, limit: 10 }),
    enabled: Boolean(eventId),
  });

  // Only asked for on an event BLUP listed for somebody — the claim button has
  // to know whether the viewer runs an organization to claim it for.
  const myOrgs = useQuery({
    queryKey: ['organizations', 'mine'],
    queryFn: getMyOrganizations,
    enabled: !isGuest && Boolean(event.data?.listed_by_platform),
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

  // The address bar gets the readable one.
  //
  // Both work — a uuid link somebody pasted last month still resolves — but the
  // page people are looking at should say what the event is. This goes through
  // the router rather than `history.replaceState`, which rewrites the URL
  // behind expo-router and leaves its state pointing at a route that is no
  // longer there. That desync was its own bug, and it looked like a blank page.
  const slug = event.data?.slug;
  useEffect(() => {
    if (!slug || !id || id === slug) return;
    router.replace(`/event/${slug}`);
  }, [id, slug]);

  // One recorded view per event actually opened on this screen. The fetcher
  // must not do this: it re-runs on every refetch and is shared with checkout,
  // editing and the seat plan, which is why one open used to count as three.
  const openedId = event.data?.id;
  const countedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!openedId || countedRef.current === openedId) return;
    countedRef.current = openedId;
    void recordSignal(openedId, 'open_detail', { source: 'detail' });
  }, [openedId]);

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

    return subscribeToTable({
      topic: `event-${id}`,
      table: 'event_attendees',
      filter: `event_id=eq.${id}`,
      onChange: () => {
        void queryClient.invalidateQueries({ queryKey: ['event', id] });
      },
    });
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
        await cancelRsvp(eventId!);
      } else {
        await rsvpToEvent(eventId!, status);
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
      if (data?.is_saved) await unsaveEvent(eventId!);
      else await saveEvent(eventId!);
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
      await toggleLike(eventId!, !data.is_liked);
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
        slug: data.slug,
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

  /**
   * Reporting the event.
   *
   * This used to be `Alert.prompt?.(…)` — and react-native-web has no `prompt`
   * at all, so the optional call made it a no-op: in a browser the report
   * button did nothing, said nothing, and nobody found out.
   */
  const handleReport = async () => {
    const reason = await dialog.prompt({
      title: 'Nahlásiť event',
      body: 'Čo je s ním zle? Napíš to vlastnými slovami — pozrie sa na to človek.',
      placeholder: 'Napríklad: event neexistuje, urážlivý obsah…',
      confirmLabel: 'Nahlásiť',
      multiline: true,
      required: true,
    });
    if (!reason?.trim()) return;

    try {
      await reportContent({ targetType: 'event', targetId: eventId!, reason: reason.trim() });
      setNotice('Nahlásené. Naši moderátori sa na to pozrú.');
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  const postComment = async () => {
    if (!comment.trim() || !eventId) return;
    setBusy(true);
    setCommentError(null);
    try {
      await addComment(eventId, comment);
      setComment('');
      await comments.refetch();
      await refresh();
    } catch (caught) {
      // Beside the composer, not in the notice at the top: somebody writing a
      // comment is at the bottom of a long page and never saw it up there, so
      // a refused comment looked like a button that does nothing.
      setCommentError(messageFor(caught));
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

  // Buyers see one number — the full price. This only says VAT is already in it,
  // and only for an organizer who is registered for it.
  const vatLabel = vatIncludedLabel(
    data.organization?.is_vat_payer,
    data.organization?.vat_rate_bps,
  );
  // Was `start_at < now()`, which called a three-day festival past on its second
  // day and hid the ticket list while it was still running. Same rule as
  // public.event_has_ended() now.
  const isPast = eventHasEnded(data);

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

  /**
   * Claiming an event BLUP typed in. Nothing moves on the strength of this —
   * it opens a request a person at BLUP has to agree with, because otherwise
   * anyone could take over anyone's listing.
   */
  const claimThis = async () => {
    const organization = (myOrgs.data ?? [])[0];
    if (!organization || !eventId) return;
    setError(null);
    setBusy(true);
    try {
      await claimEvent(eventId, organization.id);
      setClaimed(true);
      setNotice('Ozveme sa. Keď to overíme, event bude tvoj.');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
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
      {/* Above the cover, not on top of it: floating these over the picture cut
          the top off every portrait poster — which is where the date and the
          venue usually are. */}
      <View style={styles.heroTop}>
        <IconButton glyph="‹" onPress={() => router.back()} />
        <Pressable
          onPress={handleSave}
          style={[styles.savePill, data.is_saved && styles.savePillActive]}
        >
          <Text style={styles.savePillLabel}>
            {data.is_saved ? '★  Blupnuté' : '☆  Blup'}
          </Text>
        </Pressable>
      </View>

      <GradientCover
        uri={data.cover_image_url}
        category={data.category}
        height={300}
        whole
        wholeMinRatio={0.66}
        backdrop="blur"
        showPlaceholderLabel={false}
      />

      {/* Under the poster, not over it. The title used to sit on the picture
          with a dark gradient behind it, which on a phone covered the bottom
          third — the part with the line-up and the date on it. */}
      <View style={styles.heroBottom}>
        <View style={styles.heroChips}>
          <Chip label={categoryFamilies[familyFor(data.category)].label} />
          {data.attendee_count > 20 ? <Chip label="Frčí" /> : null}
        </View>
        <Text style={styles.heroTitle}>{data.title}</Text>
      </View>

      <View style={styles.body}>
        {error ? <Notice tone="danger" title="Niečo sa pokazilo" body={error} /> : null}
        {notice ? <Notice tone="accent" title="Hotovo" body={notice} /> : null}

        {data.status === 'cancelled' ? (
          <Notice tone="danger" title="Event bol zrušený" body="Organizátor ho odvolal." />
        ) : isPast ? (
          <Notice
            tone="teal"
            title="Tento event už bol"
            body="Stránka zostáva, aby si sa mal kam vrátiť — fotky, kto tam bol a hodnotenia. Vstupenky sa už nepredávajú."
          />
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
            url={data.listed_by_platform
              ? null
              : (data.organization?.logo_url ?? data.creator?.avatar_url)}
            name={data.listed_by_platform
              ? data.external_organizer_name
              : (data.organization?.name ?? data.creator?.display_name)}
            size={40}
            square={Boolean(data.organization) || data.listed_by_platform}
          />
          <View style={styles.flex}>
            <Caption>Organizuje</Caption>
            <Text style={styles.hostName}>
              {data.listed_by_platform
                ? data.external_organizer_name
                : (data.organization?.name ?? data.creator?.display_name ?? 'Niekto na BLUPe')}
            </Text>
            {/* An event BLUP typed in says so. Leaving the organizer blank does
                not read as "somebody else's" — it reads as ours, by omission,
                and our own terms say the contract is with the organizer. */}
            {data.listed_by_platform ? (
              <Caption>Pridal BLUP · organizátor zatiaľ nie je na BLUPe</Caption>
            ) : null}
          </View>
        </Pressable>

        {data.listed_by_platform ? (
          <Notice
            tone="accent"
            title="Tento event sme pridali my"
            body={
              `Informácie sme prebrali z verejného oznámenia. Organizuje ${data.external_organizer_name ?? 'niekto iný'}, ` +
              'nie BLUP — vstupenky sa tu nepredávajú a za priebeh zodpovedá organizátor. ' +
              'Ak je to tvoj event, prihlás sa oň a prevedieme ti ho.'
            }
            actionLabel={data.external_source_url ? 'Otvoriť zdroj' : undefined}
            onAction={
              data.external_source_url
                ? () => void openExternal(data.external_source_url!)
                : undefined
            }
          />
        ) : null}

        {data.listed_by_platform && (myOrgs.data ?? []).length > 0 ? (
          <Button
            title={claimed ? 'Nárok podaný — čaká na BLUP' : 'Toto je náš event'}
            variant="secondary"
            disabled={claimed || busy}
            onPress={() => void claimThis()}
          />
        ) : null}

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
              <Text style={styles.hostName}>{isPast ? 'Chat eventu · po akcii' : 'Chat eventu'}</Text>
              <Caption>
                {isPast
                  ? 'Zostáva otvorený — stratené veci, fotky a kto koho kde videl.'
                  : 'Dohodni sa, s kým prídeš, opýtaj sa na parkovanie a nezmeškaj, čo píše organizátor.'}
              </Caption>
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
                  <View style={styles.ticketPriceCell}>
                    <Text style={styles.ticketPrice}>
                      {formatPrice(ticket.price_cents, ticket.currency)}
                    </Text>
                    {vatLabel && ticket.price_cents > 0 ? (
                      <Caption style={styles.ticketVat}>({vatLabel})</Caption>
                    ) : null}
                  </View>
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
              loading={busy}
              onPress={() => void buy()}
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
            // The map on an event page is about the event, not about where the
            // reader happens to be standing — without this it centred on the
            // viewer's own position and the event sat off-screen.
            focus={{ latitude: data.latitude, longitude: data.longitude }}
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
              <SectionHeader title="Spoločné plány" centered />
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
                returnKeyType="done"
                onSubmitEditing={() => { if (crewName.trim()) void startCrew(); }}
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
        <View style={styles.commentBlock}>
          <SectionHeader title={`Komentáre · ${formatCount(data.comment_count)}`} centered />
        </View>

        <View style={[styles.commentInput, styles.commentBlock]}>
          {/* The flex has to be on the wrapper: Input passes `style` to the
              TextInput inside it, so flex:1 there left the field sized to its
              content and the whole row packed to the left of its centred box. */}
          <View style={styles.flex}>
            <Input
              value={comment}
              onChangeText={setComment}
              placeholder="Opýtaj sa alebo pozdrav"
              multiline
              maxLength={1000}
              style={styles.commentField}
              {...enterSubmits(() => void postComment())}
            />
          </View>
          <Button title="Poslať" compact onPress={postComment} loading={busy} disabled={!comment.trim()} />
        </View>

        {commentError ? (
          <View style={styles.commentBlock}>
            <Notice tone="danger" title="Komentár neodišiel" body={commentError} />
          </View>
        ) : null}

        {(comments.data ?? []).length === 0 ? (
          <Body muted style={styles.commentEmpty}>Zatiaľ žiadne komentáre.</Body>
        ) : (
          (comments.data ?? []).map((item) => (
            <View key={item.id} style={[styles.comment, styles.commentBlock]}>
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
          <Button title="Nahlásiť event" variant="ghost" onPress={() => void handleReport()} />
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
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
  savePill: {
    backgroundColor: colors.overlay,
    paddingHorizontal: spacing.lg,
    paddingVertical: 11,
    borderRadius: radius.md,
  },
  savePillActive: { backgroundColor: colors.accent },
  savePillLabel: { ...typography.chip, color: colors.text },
  heroBottom: {
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing.lg,
    gap: spacing.sm,
  },
  heroChips: { flexDirection: 'row', gap: spacing.sm },
  heroTitle: { ...typography.eventTitle, color: colors.text },

  body: {
    padding: spacing.gutter,
    backgroundColor: colors.background,
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
  ticketPriceCell: { alignItems: 'flex-end' },
  ticketPrice: { ...typography.subheading, color: colors.text },
  ticketVat: { marginTop: 1 },
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

  commentInput: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', marginTop: spacing.sm },
  // The comments read as a column under a centred heading, the same shape as
  // the crews above them — not as a full-width slab of text.
  commentBlock: { width: '100%', maxWidth: 520, alignSelf: 'center' },
  commentEmpty: { textAlign: 'center', alignSelf: 'center' },
  commentField: { marginBottom: 0, minHeight: 44 },
  comment: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg },
  commentAuthor: { ...typography.caption, color: colors.textSecondary, marginBottom: 2 },

  ownerActions: { gap: spacing.sm },
});
