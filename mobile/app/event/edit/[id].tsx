import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Platform, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import { cancelEvent, deleteEvent, getEvent, updateEvent } from '@/api/events';
import { logAdminEventEdit } from '@/api/admin';
import { pickImage, uploadEventCover } from '@/storage/uploads';
import { messageFor } from '@/lib/errors';
import { DateTimeField } from '@/components/DateTimeField';
import {
  Body, Button, Caption, Chip, Divider, ErrorState, Input, LoadingState, Notice, Screen,
  SectionHeader, Switch,
} from '@/components/ui';
import { colors, labelFor, radius, spacing } from '@/theme';

const CATEGORIES = [
  'techno', 'house', 'hiphop', 'rock', 'jazz', 'indie', 'festival', 'running', 'cycling',
  'climbing', 'football', 'basketball', 'yoga', 'hiking', 'art', 'theatre', 'cinema',
  'photography', 'food', 'coffee', 'wine', 'craft-beer', 'startups', 'tech', 'design',
  'networking', 'nightlife', 'bars', 'board-games', 'gaming', 'language', 'volunteering',
  'wellness', 'dance', 'other',
];

/**
 * Upraviť event.
 *
 * Everything a host can get wrong on the way in can be corrected here: the
 * date, the place, the category, the capacity, the price and whether it is
 * listed at all. RLS decides who may save — the host, an organization member
 * with the right role, or an admin — and this screen only reflects that.
 *
 * Two things it deliberately does not hide:
 *
 *   · Moving an event that already sold tickets is a real change for real
 *     people, so it is called out before saving rather than after.
 *   · An admin editing somebody else's listing is asked why, and the answer is
 *     written to the audit log. Being able to fix any event and being able to
 *     do it quietly are not the same power.
 */
export default function EditEventScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile, isAdmin } = useAuth();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('other');
  const [venueName, setVenueName] = useState('');
  const [address, setAddress] = useState('');
  const [startAt, setStartAt] = useState<Date>(new Date());
  const [durationHours, setDurationHours] = useState(3);
  const [capacity, setCapacity] = useState('');
  const [unlisted, setUnlisted] = useState(false);
  const [reason, setReason] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const event = useQuery({
    queryKey: ['event', id],
    queryFn: () => getEvent(id!),
    enabled: Boolean(id),
  });

  const data = event.data;

  useEffect(() => {
    if (!data) return;
    setTitle(data.title);
    setDescription(data.description ?? '');
    setCategory(data.category ?? 'other');
    setVenueName(data.venue_name ?? '');
    setAddress(data.address ?? '');
    setCapacity(data.capacity ? String(data.capacity) : '');
    setUnlisted(data.visibility === 'unlisted');

    const start = new Date(data.start_at);
    setStartAt(start);

    if (data.end_at) {
      const hours = (new Date(data.end_at).getTime() - start.getTime()) / 3_600_000;
      if (hours > 0 && hours <= 24) setDurationHours(Math.round(hours));
    }
  }, [data]);

  // An admin who is not the host is editing on somebody else's behalf.
  const asAdmin = useMemo(
    () => Boolean(data) && isAdmin && data!.creator_id !== profile?.id,
    [data, isAdmin, profile?.id],
  );

  const sold = data?.tickets_sold ?? 0;
  const moved = Boolean(data) && new Date(data!.start_at).getTime() !== startAt.getTime();

  if (event.isLoading) return <Screen><LoadingState /></Screen>;

  if (event.isError || !data) {
    return (
      <Screen>
        <ErrorState message={messageFor(event.error)} onRetry={() => void event.refetch()} />
      </Screen>
    );
  }

  const changeCover = async () => {
    try {
      const picked = await pickImage({ source: 'library', aspect: [16, 9] });
      if (!picked) return;
      setSaving(true);
      const { url } = await uploadEventCover(picked.uri, id!, picked.width || undefined);
      await updateEvent(id!, { coverImageUrl: url });
      await event.refetch();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    setError(null);
    setSaved(false);

    if (title.trim().length < 3) {
      setError('Názov musí mať aspoň 3 znaky.');
      return;
    }
    if (asAdmin && reason.trim().length < 5) {
      setError('Napíš dôvod zásahu — zapíše sa do audit logu.');
      return;
    }

    setSaving(true);
    try {
      await updateEvent(id!, {
        title: title.trim(),
        description,
        category,
        venueName,
        address,
        startAt,
        endAt: new Date(startAt.getTime() + durationHours * 3_600_000),
        capacity: capacity ? Number(capacity) : null,
        visibility: unlisted ? 'unlisted' : 'public',
      });

      // The audit row is written after the change lands, so the log never
      // claims an edit that the database refused.
      if (asAdmin) {
        await logAdminEventEdit(
          id!,
          ['title', 'description', 'category', 'venue', 'address', 'start_at', 'capacity', 'visibility'],
          reason.trim(),
        );
      }

      await event.refetch();
      setSaved(true);
      setReason('');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  };

  const confirm = (
    heading: string,
    body: string,
    label: string,
    run: () => Promise<void>,
  ) => {
    // Alert.alert has no browser implementation in react-native-web; window.confirm
    // is the honest equivalent rather than an action that silently does nothing.
    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-alert
      if (typeof window !== 'undefined' && window.confirm(`${heading}\n\n${body}`)) void run();
      return;
    }

    Alert.alert(heading, body, [
      { text: 'Nechať', style: 'cancel' },
      { text: label, style: 'destructive', onPress: () => void run() },
    ]);
  };

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Nepodarilo sa uložiť" body={error} /> : null}
      {saved ? (
        <Notice tone="success" title="Uložené" body="Zmena je hneď viditeľná pre všetkých." />
      ) : null}

      {asAdmin ? (
        <Notice
          tone="warning"
          title="Upravuješ cudzí event"
          body="Si tu ako admin. Zmena sa zapíše do audit logu spolu s dôvodom, ktorý napíšeš nižšie."
        />
      ) : null}

      {/* The picture that is on the event right now. Without it the button was
          a guess: on a second edit nobody remembers which of three photos is
          live, and "Zmeniť fotku" replaces it either way. */}
      <SectionHeader title="Titulná fotka" />
      {data.cover_image_url ? (
        <Image
          source={{ uri: data.cover_image_url }}
          style={styles.cover}
          contentFit="cover"
          transition={120}
          accessibilityLabel="Súčasná titulná fotka"
        />
      ) : (
        <View style={[styles.cover, styles.coverEmpty]}>
          <Body muted>Zatiaľ bez fotky — v zozname sa ukáže farebný podklad.</Body>
        </View>
      )}
      <Button
        title={data.cover_image_url ? 'Nahradiť fotku' : 'Pridať fotku'}
        variant="secondary"
        onPress={changeCover}
        disabled={saving}
      />

      {/* --- basics --------------------------------------------------------- */}
      <SectionHeader title="Detaily" />
      <Input label="Názov" value={title} onChangeText={setTitle} editable={!saving} maxLength={120} />
      <Input
        label="Popis"
        value={description}
        onChangeText={setDescription}
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
      <DateTimeField value={startAt} onChange={setStartAt} />

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

      {moved && sold > 0 ? (
        <Notice
          tone="warning"
          title={`Presúvaš event, na ktorý je predaných ${sold} vstupeniek`}
          body="Každému držiteľovi vstupenky príde notifikácia o zmene. Ak sa termín posúva výrazne, ozvi sa im aj v chate eventu."
        />
      ) : null}

      {/* --- where ---------------------------------------------------------- */}
      <SectionHeader title="Kde" />
      <Input label="Miesto" value={venueName} onChangeText={setVenueName} editable={!saving} />
      <Input label="Adresa" value={address} onChangeText={setAddress} editable={!saving} />
      <Caption>
        Súradnice sa menia posunom špendlíka pri vytváraní. Ak sa event sťahuje inam, zruš ho a
        vytvor nový — ľudia, čo si kúpili vstupenku, dostanú peniaze späť.
      </Caption>

      {/* --- listing -------------------------------------------------------- */}
      <SectionHeader title="Zoznam a kapacita" />
      <Input
        label="Kapacita"
        value={capacity}
        onChangeText={setCapacity}
        keyboardType="number-pad"
        placeholder="Nechaj prázdne pre neobmedzenú"
        editable={!saving}
      />
      <Switch
        label="Skrytý zo zoznamu"
        description="Event nebude vo feede ani vo vyhľadávaní. Otvorí sa len tomu, kto má odkaz."
        value={unlisted}
        onValueChange={setUnlisted}
      />

      {!data.is_free ? (
        <Caption>
          Ceny a typy vstupeniek sa menia v sekcii Organizátor → Vstupenky, aby úprava eventu
          nemohla omylom prepísať to, čo už niekto zaplatil.
        </Caption>
      ) : null}

      {asAdmin ? (
        <>
          <SectionHeader title="Dôvod zásahu" />
          <Input
            label=""
            value={reason}
            onChangeText={setReason}
            placeholder="napr. na žiadosť organizátora opravený dátum"
            editable={!saving}
          />
        </>
      ) : null}

      <Button title="Uložiť zmeny" onPress={() => void save()} loading={saving} />

      <Divider />

      <Body muted>
        Zrušený event zostane viditeľný ako zrušený a držitelia vstupeniek dostanú peniaze späť.
        Zmazanie je nezvratné a použije sa len na niečo, čo tam vôbec nemalo byť.
      </Body>

      <Button
        title="Zrušiť event"
        variant="danger"
        onPress={() =>
          confirm(
            'Zrušiť tento event?',
            'Každý, kto sa prihlásil, ho uvidí ako zrušený.',
            'Zrušiť event',
            async () => {
              try {
                await cancelEvent(id!);
                await queryClient.invalidateQueries({ queryKey: ['event', id] });
                await queryClient.invalidateQueries({ queryKey: ['events'] });
                router.replace(`/event/${id}`);
              } catch (caught) {
                setError(messageFor(caught));
              }
            },
          )
        }
      />

      <Button
        title="Zmazať natrvalo"
        variant="ghost"
        onPress={() =>
          confirm(
            'Zmazať natrvalo?',
            'Toto sa nedá vrátiť. Zmiznú aj vstupenky a prihlášky.',
            'Zmazať',
            async () => {
              try {
                await deleteEvent(id!);
                // Drop it from every cache before leaving, or the feed keeps
                // showing the event for as long as its data stays fresh — which
                // reads as "delete did nothing".
                queryClient.removeQueries({ queryKey: ['event', id] });
                await queryClient.invalidateQueries({ queryKey: ['events'] });
                await queryClient.invalidateQueries({ queryKey: ['ai'] });
                router.replace('/');
              } catch (caught) {
                setError(messageFor(caught));
              }
            },
          )
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  textarea: { height: 110, textAlignVertical: 'top', paddingTop: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  cover: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    marginBottom: spacing.md,
  },
  coverEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    padding: spacing.lg,
  },
});
