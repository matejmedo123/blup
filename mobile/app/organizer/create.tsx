import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Image } from 'expo-image';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';

import { useAuth } from '@/auth/AuthProvider';
import { useLocation } from '@/hooks/useLocation';
import { createEventWithTickets } from '@/api/events';
import { createPersonalOrganization, getMyOrganizations } from '@/api/organizations';
import { getMyCommunities } from '@/api/communities';
import { pickImage, uploadEventCover } from '@/storage/uploads';
import { geocodeAddress, suggestAddresses, type GeocodeHit } from '@/maps/geocode';
import { messageFor } from '@/lib/errors';
import { eventHref, formatEventDateLong } from '@/lib/format';
import { EventMap } from '@/components/EventMap';
import { DateTimeField } from '@/components/DateTimeField';
import {
  Body, Button, Caption, Chip, Input, Notice, Screen, SectionHeader, Switch,
} from '@/components/ui';
import { colors, labelFor, radius, spacing, typography } from '@/theme';
import type { EventFeedItem } from '@/types/models';

const CATEGORIES = [
  'techno', 'house', 'hiphop', 'rock', 'jazz', 'indie', 'festival', 'running', 'cycling',
  'climbing', 'football', 'basketball', 'yoga', 'hiking', 'art', 'theatre', 'cinema',
  'photography', 'food', 'coffee', 'wine', 'craft-beer', 'startups', 'tech', 'design',
  'networking', 'nightlife', 'bars', 'board-games', 'gaming', 'language', 'volunteering',
  'wellness', 'dance', 'other',
];

/**
 * Create event.
 *
 * Free events: anyone. Paid events: only through a VERIFIED organization —
 * enforced by the database, and surfaced here so the rule is never a surprise.
 */
const MAX_TICKET_TYPES = 8;

/** One ticket-type row while it is still being typed, so values stay strings. */
interface TicketDraft {
  key: string;
  name: string;
  price: string;
  quantity: string;
}

let ticketKeySeq = 0;
const blankTicket = (): TicketDraft => ({
  key: `t${++ticketKeySeq}`,
  name: '',
  price: '',
  quantity: '',
});

const centsFrom = (value: string): number =>
  Math.round(Number(value.replace(',', '.') || 0) * 100);

/** The event's headline price: the cheapest ticket, or 0 while none is typed. */
const cheapestCents = (tickets: TicketDraft[]): number => {
  const priced = tickets.map((t) => centsFrom(t.price)).filter((c) => c > 0);
  return priced.length === 0 ? 0 : Math.min(...priced);
};

export default function CreateEventScreen() {
  const { profile } = useAuth();
  const location = useLocation();
  const queryClient = useQueryClient();

  const [draftId] = useState(() => Crypto.randomUUID());
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('other');
  const [venueName, setVenueName] = useState('');
  const [address, setAddress] = useState('');
  const [capacity, setCapacity] = useState('');
  const [isFree, setIsFree] = useState(true);
  const [ticketTypes, setTicketTypes] = useState<TicketDraft[]>([blankTicket()]);
  // How the event sells. Most sell without places at all; a hall with a
  // seating plan is the exception, and building one is work — so it is a
  // deliberate choice rather than something every organizer walks through.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const addTicket = () =>
    setTicketTypes((current) =>
      current.length >= MAX_TICKET_TYPES ? current : [...current, blankTicket()]);

  const removeTicket = (key: string) =>
    setTicketTypes((current) =>
      current.length <= 1 ? current : current.filter((t) => t.key !== key));

  const patchTicket = (key: string, patch: Partial<TicketDraft>) =>
    setTicketTypes((current) =>
      current.map((t) => (t.key === key ? { ...t, ...patch } : t)));

  /**
   * What the feed card will say. The event's own price is the cheapest ticket,
   * so showing it here means the organizer sees the listing before publishing
   * rather than discovering it afterwards.
   */
  const cheapestLabel = (() => {
    const amounts = ticketTypes
      .map((t) => Number(t.price.replace(',', '.')))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (amounts.length === 0) return null;
    const min = Math.min(...amounts);
    return amounts.length === 1
      ? `${min.toFixed(2).replace('.', ',')} €`
      : `od ${min.toFixed(2).replace('.', ',')} €`;
  })();
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [communityId, setCommunityId] = useState<string | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [coverMissing, setCoverMissing] = useState(false);
  const [mapFocus, setMapFocus] = useState<{ latitude: number; longitude: number } | null>(null);
  const [suggestions, setSuggestions] = useState<GeocodeHit[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [coverSize, setCoverSize] = useState<{ width: number; height: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [foundLabel, setFoundLabel] = useState<string | null>(null);
  const [uploadingCover, setUploadingCover] = useState(false);

  const [startAt, setStartAt] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    date.setHours(19, 0, 0, 0);
    return date;
  });
  const [durationHours, setDurationHours] = useState(3);
  // A festival is not a long evening. Hours cover most events; anything that
  // crosses midnight more than once needs a real end date, not a bigger chip.
  const [multiDay, setMultiDay] = useState(false);
  const [endAt, setEndAt] = useState<Date>(() => new Date(Date.now() + 26 * 3600 * 1000));

  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [creatingOrg, setCreatingOrg] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const organizationsQuery = useQuery({
    queryKey: ['organizations', 'mine'],
    queryFn: getMyOrganizations,
  });

  const organizations = organizationsQuery.data;

  // Communities you belong to can host the event as a micro-event.
  const communitiesQuery = useQuery({
    queryKey: ['communities', 'mine'],
    queryFn: getMyCommunities,
  });

  const verifiedOrgs = useMemo(
    () => (organizations ?? []).filter((org) => org.verification_status === 'verified'),
    [organizations],
  );

  /** An organization that exists but cannot sell yet — waiting, or turned down. */
  const pendingOrg = useMemo(
    () => (organizations ?? []).find((org) => org.verification_status !== 'verified') ?? null,
    [organizations],
  );

  const eventCoords = coords ?? location.coords;

  /** One definition of when it ends, so preview and submit cannot disagree. */
  const endsAt = multiDay ? endAt : new Date(startAt.getTime() + durationHours * 3600 * 1000);

  // The map preview shows the draft exactly as it will be published. Building a
  // complete EventFeedItem (rather than casting a partial one to `never`) is
  // what keeps preview and card in sync — a missing field is a compile error.
  const draftPreview = useMemo<EventFeedItem[]>(() => {
    if (!eventCoords) return [];

    return [{
      id: 'draft',
      // A draft has no address yet; the trigger writes one on insert.
      slug: null,
      title: title.trim() || 'Tvoj event',
      description: description.trim() || null,
      cover_image_url: coverUrl,
      category,
      tags: [],
      latitude: eventCoords.latitude,
      longitude: eventCoords.longitude,
      address: address || null,
      venue_name: venueName || null,
      city: location.city ?? null,
      start_at: startAt.toISOString(),
      end_at: endsAt.toISOString(),
      is_free: isFree,
      price_cents: isFree ? 0 : cheapestCents(ticketTypes),
      currency: 'EUR',
      capacity: capacity ? Number(capacity) : null,
      attendee_count: 0,
      saved_count: 0,
      like_count: 0,
      comment_count: 0,
      status: 'draft',
      visibility: 'public',
      creator_id: profile?.id ?? '',
      creator_username: profile?.username ?? null,
      creator_display_name: profile?.display_name ?? null,
      creator_avatar_url: profile?.avatar_url ?? null,
      organization_id: organizationId,
      organization_name: null,
      organization_verified: null,
      distance_m: null,
      friends_going: 0,
      is_saved: false,
      is_attending: false,
      score: null,
      score_breakdown: null,
    }];
  }, [
    eventCoords, title, description, coverUrl, category, address, venueName,
    location.city, startAt, endsAt, isFree, ticketTypes, capacity, profile,
    organizationId,
  ]);

  /**
   * Moves the pin to the typed address. Dragging a pin across a city to find a
   * street you already know the name of is work the geocoder can do.
   */
  const findAddress = async () => {
    setError(null);
    setLocating(true);
    try {
      const parts = [address, venueName].filter((p) => p.trim().length > 0);
      const hit = await geocodeAddress(parts.join(', '));
      if (!hit) {
        setFoundLabel(null);
        setError('Túto adresu sme nenašli. Skús ju napísať inak, alebo posuň špendlík ručne.');
        return;
      }
      setCoords({ latitude: hit.latitude, longitude: hit.longitude });
      setMapFocus({ latitude: hit.latitude, longitude: hit.longitude });
      setFoundLabel(hit.label);
      setSuggestions([]);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setLocating(false);
    }
  };

  /**
   * Suggestions while typing. Nominatim asks for at most a request a second, so
   * this waits until the typing stops rather than firing per keystroke, and the
   * in-flight request is abandoned as soon as the text changes again.
   */
  useEffect(() => {
    const query = address.trim();
    if (!suggesting || query.length < 4) {
      setSuggestions([]);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      suggestAddresses(query, { signal: controller.signal })
        .then(setSuggestions)
        .catch(() => {
          // Typing faster than the geocoder answers is not an error worth
          // showing anybody.
        });
    }, 500);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [address, suggesting]);

  /** Picks one of the suggestions: fills the field and moves the pin. */
  const useSuggestion = (hit: GeocodeHit) => {
    // The geocoder's label is the full postal chain down to the country. The
    // first few parts are the address; the rest is noise in a form field.
    setAddress(hit.label.split(',').slice(0, 3).join(',').trim());
    setCoords({ latitude: hit.latitude, longitude: hit.longitude });
    setMapFocus({ latitude: hit.latitude, longitude: hit.longitude });
    setFoundLabel(hit.label);
    setSuggestions([]);
    setSuggesting(false);
  };

  const changeCover = async () => {
    setError(null);
    try {
      const picked = await pickImage({ source: 'library', aspect: [16, 9] });
      if (!picked) return;

      setUploadingCover(true);
      const cover = await uploadEventCover(picked.uri, draftId, picked.width || undefined);
      setCoverUrl(cover.url);
      setCoverSize({ width: cover.width, height: cover.height });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setUploadingCover(false);
    }
  };

  const validate = (): string | null => {
    if (title.trim().length < 3) return 'Daj eventu názov (aspoň 3 znaky).';
    // The feed is a wall of cards; one without a picture is the one nobody
    // opens. Cheaper to insist here than to explain it later.
    if (!coverUrl) {
      setCoverMissing(true);
      return 'Pridaj titulnú fotku — bez nej sa event vo feede stratí.';
    }
    if (multiDay) {
      if (endsAt <= startAt) return 'Koniec musí byť po začiatku.';
      if (endsAt.getTime() - startAt.getTime() > 30 * 24 * 3600 * 1000) {
        return 'Event dlhší ako 30 dní radšej rozdeľ na viac eventov.';
      }
    }
    if (!eventCoords) return 'Vyber miesto — klikni na mapu alebo zapni GPS.';
    if (startAt.getTime() < Date.now() - 60_000) return 'Vyber čas začiatku v budúcnosti.';
    if (!isFree) {
      if (!organizationId) return 'Platené eventy môže zverejniť iba overená organizácia.';

      const errors: Record<string, string> = {};
      ticketTypes.forEach((ticket, index) => {
        if (ticket.name.trim().length < 2) {
          errors[`ticket.${index}.name`] = 'Pomenuj tento typ.';
        }
        const amount = Number(ticket.price.replace(',', '.'));
        if (!Number.isFinite(amount) || amount <= 0) {
          errors[`ticket.${index}.price`] = 'Cena musí byť vyššia ako nula.';
        }
        const count = Number(ticket.quantity);
        if (!Number.isInteger(count) || count < 1) {
          errors[`ticket.${index}.quantity`] = 'Zadaj, koľko ich je.';
        }
      });

      const names = ticketTypes.map((t) => t.name.trim().toLowerCase()).filter(Boolean);
      if (new Set(names).size !== names.length) {
        return 'Dva typy vstupeniek nemôžu mať rovnaký názov.';
      }

      setFieldErrors(errors);
      if (Object.keys(errors).length > 0) {
        return 'Doplň, čo chýba pri vstupenkách.';
      }
    }
    if (capacity && (!Number.isInteger(Number(capacity)) || Number(capacity) < 1)) {
      return 'Kapacita musí byť celé číslo.';
    }
    return null;
  };

  /**
   * "Ticketing pre všetkých": creates a personal organizer profile from the
   * signed-in profile and drops the user straight into verification, instead of
   * making them fill in a company form before they can price a ticket.
   */
  const becomeOrganizer = async () => {
    if (!profile) return;
    setError(null);
    setCreatingOrg(true);
    try {
      const organization = await createPersonalOrganization({
        id: profile.id,
        display_name: profile.display_name,
        username: profile.username,
        email: profile.email,
        city: profile.city,
      });

      await organizationsQuery.refetch();
      setOrganizationId(organization.id);
      router.push('/organizer/verification');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setCreatingOrg(false);
    }
  };

  const submit = async () => {
    setError(null);
    setCoverMissing(false);

    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }

    setSaving(true);
    try {

      // The event and its ticket types are written in one transaction, so a
      // paid event can never come out with nothing on sale.
      const event = await createEventWithTickets(
        {
          title,
          description,
          category,
          latitude: eventCoords!.latitude,
          longitude: eventCoords!.longitude,
          address: address || null || undefined,
          venueName: venueName || undefined,
          city: location.city ?? undefined,
          startAt,
          endAt: endsAt,
          capacity: capacity ? Number(capacity) : null,
          isFree,
          coverImageUrl: coverUrl,
          organizationId,
          communityId,
          status: 'published',
        },
        isFree
          ? []
          : ticketTypes.map((ticket) => ({
              name: ticket.name,
              priceCents: centsFrom(ticket.price),
              quantityTotal: Number(ticket.quantity),
            })),
      );

      // Reset so a second event does not inherit the first one's details.
      setTitle('');
      setDescription('');
      setCoverUrl(null);
      setCoverSize(null);
      setCapacity('');
      setTicketTypes([blankTicket()]);
      setFieldErrors({});

      // The feed holds its list for a while; without this the organizer lands
      // back on a home screen that does not contain the event they just
      // published, which reads as the publish having failed.
      await queryClient.invalidateQueries({ queryKey: ['events'] });
      await queryClient.invalidateQueries({ queryKey: ['ai'] });
      await queryClient.invalidateQueries({ queryKey: ['feed'] });

      router.push(eventHref(event));
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen scroll contentStyle={styles.content}>
      <Text style={styles.title}>Vytvor event</Text>
      <Body muted style={styles.intro}>
        Hneď po zverejnení je vonku — na mape, vo vyhľadávaní aj vo feede ostatných.
      </Body>

      {error ? <Notice tone="danger" title="Toto ešte oprav" body={error} /> : null}

      {/* --- cover ---------------------------------------------------------- */}
      <Pressable onPress={changeCover} style={styles.cover} disabled={uploadingCover}>
        {coverUrl ? (
          <Image source={{ uri: coverUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View style={[styles.coverPlaceholder, coverMissing && styles.coverMissing]}>
            <Text style={styles.coverEmoji}>📷</Text>
            <Caption>{uploadingCover ? 'Nahrávam…' : 'Pridaj titulnú fotku'}</Caption>
            <Caption style={styles.coverHint}>Odporúčame 1920 × 1080 px, na šírku</Caption>
          </View>
        )}
      </Pressable>

      {coverUrl ? (
        <>
          <Caption style={styles.coverSize}>
            {coverSize
              ? `Nahraté ${coverSize.width} × ${coverSize.height} px${
                  coverSize.height > coverSize.width
                    ? ' — plagát na výšku ukážeme celý.'
                    : ''
                }`
              : 'Odporúčame 1920 × 1080 px, na šírku.'}
          </Caption>
          <View style={styles.coverActions}>
            <Button title="Vymeniť" variant="ghost" compact onPress={changeCover} />
            <Button
              title="Odstrániť"
              variant="ghost"
              compact
              onPress={() => {
                setCoverUrl(null);
                setCoverSize(null);
              }}
            />
          </View>
        </>
      ) : null}

      {/* --- basics --------------------------------------------------------- */}
      <Input
        label="Názov"
        value={title}
        onChangeText={setTitle}
        placeholder="Západ slnka a beh pri Dunaji"
        maxLength={120}
        editable={!saving}
      />

      <Input
        label="Popis"
        value={description}
        onChangeText={setDescription}
        placeholder="Čo to je, pre koho to je, čo si majú ľudia priniesť?"
        multiline
        numberOfLines={4}
        maxLength={5000}
        style={styles.textarea}
        editable={!saving}
      />

      <SectionHeader title="Kategória" />
      <View style={styles.chips}>
        {CATEGORIES.map((item) => (
          <Chip
            key={item}
            label={labelFor(item)}
            selected={category === item}
            onPress={() => setCategory(item)}
          />
        ))}
      </View>

      {/* --- when ----------------------------------------------------------- */}
      <SectionHeader title="Kedy" />
      <DateTimeField value={startAt} onChange={setStartAt} minimumDate={new Date()} />

      <Caption style={styles.fieldLabel}>Ako dlho trvá</Caption>
      <View style={styles.chips}>
        {[2, 3, 4, 6, 8, 12].map((hours) => (
          <Chip
            key={hours}
            label={`${hours}h`}
            selected={!multiDay && durationHours === hours}
            onPress={() => { setMultiDay(false); setDurationHours(hours); }}
          />
        ))}
        <Chip
          label="Viac dní"
          selected={multiDay}
          onPress={() => {
            setMultiDay(true);
            // Start from the day after, so the field opens somewhere sensible
            // rather than at a time already behind the start.
            if (endAt <= startAt) setEndAt(new Date(startAt.getTime() + 26 * 3600 * 1000));
          }}
        />
      </View>

      {multiDay ? (
        <DateTimeField
          label="Koniec"
          value={endAt}
          onChange={setEndAt}
          minimumDate={startAt}
        />
      ) : null}

      {/* --- where ---------------------------------------------------------- */}
      <SectionHeader title="Kde" />
      <Caption style={styles.mapHint}>
        {coords ? 'Miesto je nastavené.' : 'Používame tvoju aktuálnu pozíciu — klikni na mapu a posuň špendlík.'}
      </Caption>

      <View style={styles.mapWrapper}>
        <EventMap
          events={draftPreview}
          userLocation={location.coords}
          focus={mapFocus}
          style={styles.map}
          onRegionChange={(region) =>
            setCoords({ latitude: region.latitude, longitude: region.longitude })
          }
        />
        <View style={styles.mapCrosshair} pointerEvents="none">
          <Text style={styles.mapCrosshairText}>📍</Text>
        </View>
      </View>

      <Input
        label="Miesto"
        value={venueName}
        onChangeText={setVenueName}
        placeholder="Stará tržnica"
        editable={!saving}
      />
      <Input
        label="Adresa"
        value={address}
        onChangeText={(v) => { setAddress(v); setFoundLabel(null); setSuggesting(true); }}
        placeholder="Námestie SNP 25, Bratislava"
        editable={!saving}
        returnKeyType="search"
        onSubmitEditing={() => {
          setSuggesting(false);
          if (address.trim().length >= 4) void findAddress();
        }}
        hint="Píš a vyber z návrhov — alebo stlač Enter a špendlík skočí, kam patrí."
      />

      {suggestions.length > 0 ? (
        <View style={styles.suggestions}>
          {suggestions.map((hit) => (
            <Pressable
              key={`${hit.latitude},${hit.longitude}`}
              onPress={() => useSuggestion(hit)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.suggestion, pressed && styles.suggestionPressed]}
            >
              <Body numberOfLines={2}>{hit.label}</Body>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Button
        title={locating ? 'Hľadám…' : 'Nájsť adresu na mape'}
        variant="secondary"
        full
        onPress={findAddress}
        loading={locating}
        disabled={saving || address.trim().length < 4}
      />
      {foundLabel ? (
        <Caption style={styles.foundLabel}>📍 {foundLabel}</Caption>
      ) : null}

      {/* --- micro-event ----------------------------------------------------- */}
      {(communitiesQuery.data ?? []).length > 0 ? (
        <>
          <SectionHeader title="Robí to niektorá z tvojich komunít?" />
          <Caption style={styles.orgHint}>
            Ak áno, komunita sa uvedie ako organizátor a event pribudne aj do jej
            zoznamu. Viditeľnosť sa tým nemení — verejný event vidia všetci tak či tak.
          </Caption>
          <View style={styles.chips}>
            <Chip
              label="Nie, samostatný"
              selected={communityId === null}
              onPress={() => setCommunityId(null)}
            />
            {(communitiesQuery.data ?? []).map((community) => (
              <Chip
                key={community.id}
                label={community.name}
                selected={communityId === community.id}
                onPress={() => setCommunityId(community.id)}
              />
            ))}
          </View>
        </>
      ) : null}

      {/* --- tickets -------------------------------------------------------- */}
      <SectionHeader title="Vstupenky" />
      <Switch
        value={isFree}
        onValueChange={(next) => {
          setIsFree(next);
          if (next) setFieldErrors({});
        }}
        label="Event zdarma"
        description="Eventy zdarma môže vytvoriť ktokoľvek. Na predaj vstupeniek potrebuješ overený účet organizátora."
      />

      {!isFree ? (
        verifiedOrgs.length === 0 ? (
          // Having no *verified* organization is not the same as having none.
          // Offering to create a second one to somebody who is simply waiting
          // for verification collided on the slug and failed.
          pendingOrg ? (
            <Notice
              tone="warning"
              title={
                pendingOrg.verification_status === 'rejected'
                  ? `Overenie ${pendingOrg.name} neprešlo`
                  : `${pendingOrg.name} čaká na overenie`
              }
              body={
                pendingOrg.verification_status === 'rejected'
                  ? 'Pozri sa, čo treba doplniť, a pošli žiadosť znova. Dovtedy vieš zverejňovať eventy zdarma.'
                  : 'Kým to prejde, môžeš zverejňovať eventy zdarma. Predaj vstupeniek sa odomkne hneď po overení.'
              }
              actionLabel="Otvoriť overenie"
              onAction={() => router.push('/organizer/verification')}
            />
          ) : (
            <Notice
              tone="warning"
              title="Na predaj vstupeniek potrebuješ profil organizátora"
              body="Vstupné si môže nastaviť ktokoľvek — stačí jedno klepnutie. Peniaze však vieme vyplatiť až overenému subjektu, to je zákonná požiadavka, nie naše pravidlo."
              actionLabel={creatingOrg ? 'Zakladám…' : 'Založiť to za mňa'}
              onAction={becomeOrganizer}
            />
          )
        ) : (
          <>
            <Caption style={styles.orgHint}>Zverejniť ako</Caption>
            <View style={styles.chips}>
              {verifiedOrgs.map((org) => (
                <Chip
                  key={org.id}
                  label={org.name}
                  selected={organizationId === org.id}
                  onPress={() => setOrganizationId(org.id)}
                />
              ))}
            </View>

            {ticketTypes.map((ticket, index) => (
              <View key={ticket.key} style={styles.ticketCard}>
                <View style={styles.ticketHead}>
                  <Caption>{index === 0 ? 'Typ vstupenky' : `Typ vstupenky ${index + 1}`}</Caption>
                  {ticketTypes.length > 1 ? (
                    <Button
                      title="Odstrániť"
                      variant="ghost"
                      compact
                      onPress={() => removeTicket(ticket.key)}
                      disabled={saving}
                    />
                  ) : null}
                </View>

                <Input
                  label="Názov"
                  value={ticket.name}
                  onChangeText={(v) => patchTicket(ticket.key, { name: v })}
                  placeholder="Napr. Early bird"
                  error={fieldErrors[`ticket.${index}.name`]}
                  editable={!saving}
                />

                <View style={styles.ticketRow}>
                  <View style={styles.ticketCell}>
                    <Input
                      label="Cena (EUR)"
                      value={ticket.price}
                      onChangeText={(v) => patchTicket(ticket.key, { price: v })}
                      placeholder="15"
                      keyboardType="decimal-pad"
                      error={fieldErrors[`ticket.${index}.price`]}
                      editable={!saving}
                    />
                  </View>
                  <View style={styles.ticketCell}>
                    <Input
                      label="Počet"
                      value={ticket.quantity}
                      onChangeText={(v) => patchTicket(ticket.key, { quantity: v })}
                      placeholder="100"
                      keyboardType="number-pad"
                      error={fieldErrors[`ticket.${index}.quantity`]}
                      editable={!saving}
                    />
                  </View>
                </View>
              </View>
            ))}

            <Pressable
              onPress={addTicket}
              disabled={saving || ticketTypes.length >= MAX_TICKET_TYPES}
              accessibilityRole="button"
              accessibilityLabel="Pridať ďalší typ vstupenky"
              style={({ pressed }) => [
                styles.addTicket,
                pressed && styles.addTicketPressed,
                ticketTypes.length >= MAX_TICKET_TYPES && styles.addTicketDisabled,
              ]}
            >
              <View style={styles.addTicketPlus}>
                <Text style={styles.addTicketPlusGlyph}>+</Text>
              </View>
              <Body style={styles.addTicketLabel}>
                {ticketTypes.length >= MAX_TICKET_TYPES
                  ? `Viac ako ${MAX_TICKET_TYPES} typov už nie`
                  : 'Pridať ďalší typ vstupenky'}
              </Body>
            </Pressable>

            <Caption style={styles.ticketHint}>
              {cheapestLabel
                ? `V zozname sa event ukáže ako „${cheapestLabel}“.`
                : 'Ľudia uvidia všetky typy pri kúpe. Ceny a počty vieš neskôr upraviť.'}
            </Caption>

          </>
        )
      ) : null}

      <Input
        label="Kapacita (nepovinné)"
        value={capacity}
        onChangeText={setCapacity}
        placeholder="Nechaj prázdne pre neobmedzenú"
        keyboardType="number-pad"
        editable={!saving}
      />

      <Button
        title="Zverejniť event"
        onPress={submit}
        loading={saving}
        style={styles.submit}
      />

      {!profile?.onboarding_completed ? (
        <Caption style={styles.footnote}>Doplň si profil, nech ľudia vedia, kto event robí.</Caption>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xxxl },

  ticketCard: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  ticketHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  ticketRow: { flexDirection: 'row', gap: spacing.sm },
  // minWidth:0 or the two cells refuse to shrink and the labels wrap a
  // character per line on a narrow phone.
  ticketCell: { flex: 1, minWidth: 0 },
  // Outlined only after a failed submit — a form that scolds you for not yet
  // having filled it in is a form that shouts at everyone.
  coverMissing: { borderWidth: 1, borderColor: colors.danger, borderRadius: radius.lg },
  coverHint: { marginTop: 2 },
  suggestions: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginBottom: spacing.md,
  },
  suggestion: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  suggestionPressed: { backgroundColor: colors.surfaceElevated },
  coverSize: { marginTop: spacing.xs, textAlign: 'center', alignSelf: 'center' },
  fieldLabel: { marginTop: spacing.md, marginBottom: spacing.xs },
  ticketHint: { marginTop: spacing.xs, marginBottom: spacing.md },

  // A dashed outline reads as "there is room for another one here", which a
  // solid button does not — it would compete with "Zverejniť event".
  addTicket: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: 18,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    marginBottom: spacing.xs,
  },
  addTicketPressed: { backgroundColor: colors.surface },
  addTicketDisabled: { opacity: 0.45 },
  addTicketPlus: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addTicketPlusGlyph: {
    color: colors.accent,
    fontSize: 20,
    lineHeight: 24,
    fontWeight: '700',
  },
  addTicketLabel: { color: colors.textSecondary, flex: 1, minWidth: 0 },
  title: { ...typography.title, color: colors.text },
  intro: { marginTop: spacing.xs, marginBottom: spacing.xl },

  cover: {
    height: 180,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    overflow: 'hidden',
    marginBottom: spacing.md,
  },
  coverPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  coverEmoji: { fontSize: 32 },
  coverActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginBottom: spacing.lg },

  textarea: { height: 110, textAlignVertical: 'top', paddingTop: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginBottom: spacing.lg },


  mapHint: { marginBottom: spacing.sm },
  mapWrapper: {
    // Taller, because 220 showed the pin and almost none of the streets
    // around it — which is the part that tells you the pin is right.
    height: 300,
    borderRadius: radius.lg,
    overflow: 'hidden',
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  map: { flex: 1 },
  mapCrosshair: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  mapCrosshairText: { fontSize: 30, marginBottom: 20 },

  foundLabel: { marginTop: spacing.xs, marginBottom: spacing.md },
  orgHint: { marginBottom: spacing.sm },
  submit: { marginTop: spacing.lg },
  footnote: { textAlign: 'center', marginTop: spacing.md },
});
