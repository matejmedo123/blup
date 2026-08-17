import React, { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Image } from 'expo-image';
import { useQuery } from '@tanstack/react-query';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as Crypto from 'expo-crypto';

import { useAuth } from '@/auth/AuthProvider';
import { useLocation } from '@/hooks/useLocation';
import { createEvent } from '@/api/events';
import { getMyOrganizations } from '@/api/organizations';
import { pickImage, uploadEventCover } from '@/storage/uploads';
import { messageFor } from '@/lib/errors';
import { formatEventDateLong } from '@/lib/format';
import { EventMap } from '@/components/EventMap';
import {
  Body, Button, Caption, Chip, Input, Notice, Screen, SectionHeader, Switch,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

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
  const [picker, setPicker] = useState<'date' | 'time' | null>(null);

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
    if (title.trim().length < 3) return 'Give your event a title (at least 3 characters).';
    if (!eventCoords) return 'Pick a location — tap the map or turn on your GPS.';
    if (startAt.getTime() < Date.now() - 60_000) return 'Pick a start time in the future.';
    if (!isFree) {
      if (!organizationId) return 'Ticketed events must be published by a verified organization.';
      const amount = Number(price.replace(',', '.'));
      if (!Number.isFinite(amount) || amount <= 0) return 'Set a ticket price above zero.';
    }
    if (capacity && (!Number.isInteger(Number(capacity)) || Number(capacity) < 1)) {
      return 'Capacity must be a whole number.';
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
          'Event published',
          'Now add ticket types so people can buy. You can do that from the organizer dashboard.',
          [
            { text: 'Later', onPress: () => router.push(`/event/${event.id}`) },
            { text: 'Add tickets', onPress: () => router.push(`/organizer/tickets/${event.id}`) },
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
      <Text style={styles.title}>Create a BLUP</Text>
      <Body muted style={styles.intro}>
        It goes live the moment you publish — on the map, in search and in other people’s feeds.
      </Body>

      {error ? <Notice tone="danger" title="Fix this first" body={error} /> : null}

      {/* --- cover ---------------------------------------------------------- */}
      <Pressable onPress={changeCover} style={styles.cover} disabled={uploadingCover}>
        {coverUrl ? (
          <Image source={{ uri: coverUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View style={styles.coverPlaceholder}>
            <Text style={styles.coverEmoji}>📷</Text>
            <Caption>{uploadingCover ? 'Uploading…' : 'Add a cover photo'}</Caption>
          </View>
        )}
      </Pressable>

      {coverUrl ? (
        <View style={styles.coverActions}>
          <Button title="Replace" variant="ghost" compact onPress={changeCover} />
          <Button title="Remove" variant="ghost" compact onPress={() => setCoverUrl(null)} />
        </View>
      ) : null}

      {/* --- basics --------------------------------------------------------- */}
      <Input
        label="Title"
        value={title}
        onChangeText={setTitle}
        placeholder="Sunset run along the river"
        maxLength={120}
        editable={!saving}
      />

      <Input
        label="Description"
        value={description}
        onChangeText={setDescription}
        placeholder="What is it, who is it for, what should people bring?"
        multiline
        numberOfLines={4}
        maxLength={5000}
        style={styles.textarea}
        editable={!saving}
      />

      <SectionHeader title="Category" />
      <View style={styles.chips}>
        {CATEGORIES.map((item) => (
          <Chip
            key={item}
            label={item}
            selected={category === item}
            onPress={() => setCategory(item)}
          />
        ))}
      </View>

      {/* --- when ----------------------------------------------------------- */}
      <SectionHeader title="When" />
      <View style={styles.dateRow}>
        <Pressable style={styles.dateButton} onPress={() => setPicker('date')}>
          <Caption>Starts</Caption>
          <Text style={styles.dateText}>{formatEventDateLong(startAt.toISOString())}</Text>
        </Pressable>
      </View>

      {picker ? (
        <DateTimePicker
          value={startAt}
          mode={picker}
          display="spinner"
          themeVariant="dark"
          minimumDate={new Date()}
          onChange={(pickerEvent, selected) => {
            if (pickerEvent.type === 'dismissed') {
              setPicker(null);
              return;
            }
            if (selected) setStartAt(selected);
            setPicker(picker === 'date' ? 'time' : null);
          }}
        />
      ) : null}

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
      <SectionHeader title="Where" />
      <Caption style={styles.mapHint}>
        {coords ? 'Custom location set.' : 'Using your current position — tap the map to move the pin.'}
      </Caption>

      <View style={styles.mapWrapper}>
        <EventMap
          events={
            eventCoords
              ? [
                  {
                    id: 'draft',
                    latitude: eventCoords.latitude,
                    longitude: eventCoords.longitude,
                    category,
                    is_free: isFree,
                  } as never,
                ]
              : []
          }
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
        label="Venue"
        value={venueName}
        onChangeText={setVenueName}
        placeholder="Old Market Hall"
        editable={!saving}
      />
      <Input
        label="Address"
        value={address}
        onChangeText={setAddress}
        placeholder="Námestie SNP 25, Bratislava"
        editable={!saving}
      />

      {/* --- tickets -------------------------------------------------------- */}
      <SectionHeader title="Tickets" />
      <Switch
        value={isFree}
        onValueChange={(next) => {
          setIsFree(next);
          if (next) setPrice('');
        }}
        label="Free event"
        description="Anyone can create free events. Selling tickets needs a verified organizer account."
      />

      {!isFree ? (
        verifiedOrgs.length === 0 ? (
          <Notice
            tone="warning"
            title="You need a verified organizer account"
            body="BLUP only lets verified organizations sell tickets — that is what makes payouts and refunds accountable."
            actionLabel="Set up an organizer account"
            onAction={() => router.push('/organizer/new')}
          />
        ) : (
          <>
            <Caption style={styles.orgHint}>Publish as</Caption>
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
              label="Ticket price (EUR)"
              value={price}
              onChangeText={setPrice}
              placeholder="15"
              keyboardType="decimal-pad"
              hint="You can add multiple ticket types after publishing."
              editable={!saving}
            />
          </>
        )
      ) : null}

      <Input
        label="Capacity (optional)"
        value={capacity}
        onChangeText={setCapacity}
        placeholder="Leave empty for unlimited"
        keyboardType="number-pad"
        editable={!saving}
      />

      <Button
        title="Publish event"
        onPress={submit}
        loading={saving}
        style={styles.submit}
      />

      {!profile?.onboarding_completed ? (
        <Caption style={styles.footnote}>Finish your profile so people know who is hosting.</Caption>
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

  dateRow: { marginBottom: spacing.md },
  dateButton: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  dateText: { ...typography.bodyStrong, color: colors.text },

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
