import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Image } from 'expo-image';
import { useQuery } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';

import { useAuth } from '@/auth/AuthProvider';
import { useLocation } from '@/hooks/useLocation';
import { createEvent } from '@/api/events';
import { getMyOrganizations } from '@/api/organizations';
import { pickImage, uploadEventCover } from '@/storage/uploads';
import { messageFor } from '@/lib/errors';
import { formatEventDateLong } from '@/lib/format';
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
export default function CreateEventScreen() {
  const { profile } = useAuth();
  const location = useLocation();

  const [draftId] = useState(() => Crypto.randomUUID());
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('other');
  const [venueName, setVenueName] = useState('');
  const [address, setAddress] = useState('');
  const [capacity, setCapacity] = useState('');
  const [isFree, setIsFree] = useState(true);
  const [price, setPrice] = useState('');
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [uploadingCover, setUploadingCover] = useState(false);

  const [startAt, setStartAt] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    date.setHours(19, 0, 0, 0);
    return date;
  });
  const [durationHours, setDurationHours] = useState(3);

  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: organizations } = useQuery({
    queryKey: ['organizations', 'mine'],
    queryFn: getMyOrganizations,
  });

  const verifiedOrgs = useMemo(
    () => (organizations ?? []).filter((org) => org.verification_status === 'verified'),
    [organizations],
  );

  const eventCoords = coords ?? location.coords;

  // The map preview shows the draft exactly as it will be published. Building a
  // complete EventFeedItem (rather than casting a partial one to `never`) is
  // what keeps preview and card in sync — a missing field is a compile error.
  const draftPreview = useMemo<EventFeedItem[]>(() => {
    if (!eventCoords) return [];

    return [{
      id: 'draft',
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
      end_at: new Date(startAt.getTime() + durationHours * 3600 * 1000).toISOString(),
      is_free: isFree,
      price_cents: isFree ? 0 : Math.round(Number(price.replace(',', '.') || 0) * 100),
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
    location.city, startAt, durationHours, isFree, price, capacity, profile,
    organizationId,
  ]);

  const changeCover = async () => {
    setError(null);
    try {
      const picked = await pickImage({ source: 'library', aspect: [16, 9] });
      if (!picked) return;

      setUploadingCover(true);
      const url = await uploadEventCover(picked.uri, draftId);
      setCoverUrl(url);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setUploadingCover(false);
    }
  };

  const validate = (): string | null => {
    if (title.trim().length < 3) return 'Daj eventu názov (aspoň 3 znaky).';
    if (!eventCoords) return 'Vyber miesto — klikni na mapu alebo zapni GPS.';
    if (startAt.getTime() < Date.now() - 60_000) return 'Vyber čas začiatku v budúcnosti.';
    if (!isFree) {
      if (!organizationId) return 'Platené eventy môže zverejniť iba overená organizácia.';
      const amount = Number(price.replace(',', '.'));
      if (!Number.isFinite(amount) || amount <= 0) return 'Nastav cenu vstupenky vyššiu ako nula.';
    }
    if (capacity && (!Number.isInteger(Number(capacity)) || Number(capacity) < 1)) {
      return 'Kapacita musí byť celé číslo.';
    }
    return null;
  };

  const submit = async () => {
    setError(null);

    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }

    setSaving(true);
    try {
      const endAt = new Date(startAt.getTime() + durationHours * 3600 * 1000);

      const event = await createEvent({
        title,
        description,
        category,
        latitude: eventCoords!.latitude,
        longitude: eventCoords!.longitude,
        address: address || null || undefined,
        venueName: venueName || undefined,
        city: location.city ?? undefined,
        startAt,
        endAt,
        capacity: capacity ? Number(capacity) : null,
        isFree,
        priceCents: isFree ? 0 : Math.round(Number(price.replace(',', '.')) * 100),
        coverImageUrl: coverUrl,
        organizationId: isFree ? organizationId : organizationId,
        status: 'published',
      });

      // Reset so a second event does not inherit the first one's details.
      setTitle('');
      setDescription('');
      setCoverUrl(null);
      setPrice('');
      setCapacity('');

      if (!isFree) {
        Alert.alert(
          'Event zverejnený',
          'Teraz pridaj typy vstupeniek, aby si ľudia mohli kúpiť. Spravíš to v nástenke organizátora.',
          [
            { text: 'Neskôr', onPress: () => router.push(`/event/${event.id}`) },
            { text: 'Pridať vstupenky', onPress: () => router.push(`/organizer/tickets/${event.id}`) },
          ],
        );
      } else {
        router.push(`/event/${event.id}`);
      }
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen scroll contentStyle={styles.content}>
      <Text style={styles.title}>Vytvor BLUP</Text>
      <Body muted style={styles.intro}>
        Hneď po zverejnení je vonku — na mape, vo vyhľadávaní aj vo feede ostatných.
      </Body>

      {error ? <Notice tone="danger" title="Toto ešte oprav" body={error} /> : null}

      {/* --- cover ---------------------------------------------------------- */}
      <Pressable onPress={changeCover} style={styles.cover} disabled={uploadingCover}>
        {coverUrl ? (
          <Image source={{ uri: coverUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View style={styles.coverPlaceholder}>
            <Text style={styles.coverEmoji}>📷</Text>
            <Caption>{uploadingCover ? 'Nahrávam…' : 'Pridaj titulnú fotku'}</Caption>
          </View>
        )}
      </Pressable>

      {coverUrl ? (
        <View style={styles.coverActions}>
          <Button title="Vymeniť" variant="ghost" compact onPress={changeCover} />
          <Button title="Odstrániť" variant="ghost" compact onPress={() => setCoverUrl(null)} />
        </View>
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

      <View style={styles.chips}>
        {[2, 3, 4, 6, 8, 12].map((hours) => (
          <Chip
            key={hours}
            label={`${hours}h`}
            selected={durationHours === hours}
            onPress={() => setDurationHours(hours)}
          />
        ))}
      </View>

      {/* --- where ---------------------------------------------------------- */}
      <SectionHeader title="Kde" />
      <Caption style={styles.mapHint}>
        {coords ? 'Miesto je nastavené.' : 'Používame tvoju aktuálnu pozíciu — klikni na mapu a posuň špendlík.'}
      </Caption>

      <View style={styles.mapWrapper}>
        <EventMap
          events={draftPreview}
          userLocation={location.coords}
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
        onChangeText={setAddress}
        placeholder="Námestie SNP 25, Bratislava"
        editable={!saving}
      />

      {/* --- tickets -------------------------------------------------------- */}
      <SectionHeader title="Vstupenky" />
      <Switch
        value={isFree}
        onValueChange={(next) => {
          setIsFree(next);
          if (next) setPrice('');
        }}
        label="Event zdarma"
        description="Eventy zdarma môže vytvoriť ktokoľvek. Na predaj vstupeniek potrebuješ overený účet organizátora."
      />

      {!isFree ? (
        verifiedOrgs.length === 0 ? (
          <Notice
            tone="warning"
            title="Potrebuješ overený účet organizátora"
            body="BLUP dovolí predávať vstupenky iba overeným organizáciám — vďaka tomu sú výplaty a refundácie dohľadateľné."
            actionLabel="Založiť účet organizátora"
            onAction={() => router.push('/organizer/new')}
          />
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

            <Input
              label="Cena vstupenky (EUR)"
              value={price}
              onChangeText={setPrice}
              placeholder="15"
              keyboardType="decimal-pad"
              hint="Po zverejnení môžeš pridať viac typov vstupeniek."
              editable={!saving}
            />
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
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },


  mapHint: { marginBottom: spacing.sm },
  mapWrapper: {
    height: 220,
    borderRadius: radius.lg,
    overflow: 'hidden',
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  map: { flex: 1 },
  mapCrosshair: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  mapCrosshairText: { fontSize: 30, marginBottom: 20 },

  orgHint: { marginBottom: spacing.sm },
  submit: { marginTop: spacing.lg },
  footnote: { textAlign: 'center', marginTop: spacing.md },
});
