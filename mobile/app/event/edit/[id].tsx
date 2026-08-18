import React, { useEffect, useState } from 'react';
import { Alert, StyleSheet } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { cancelEvent, deleteEvent, getEvent, updateEvent } from '@/api/events';
import { pickImage, uploadEventCover } from '@/storage/uploads';
import { messageFor } from '@/lib/errors';
import {
  Button, Divider, ErrorState, Input, LoadingState, Notice, Screen, SectionHeader,
} from '@/components/ui';
import { spacing } from '@/theme';

/** Edit an existing event. RLS makes sure only the host or organizers get here. */
export default function EditEventScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [venueName, setVenueName] = useState('');
  const [address, setAddress] = useState('');
  const [capacity, setCapacity] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const event = useQuery({
    queryKey: ['event', id],
    queryFn: () => getEvent(id!),
    enabled: Boolean(id),
  });

  useEffect(() => {
    if (!event.data) return;
    setTitle(event.data.title);
    setDescription(event.data.description ?? '');
    setVenueName(event.data.venue_name ?? '');
    setAddress(event.data.address ?? '');
    setCapacity(event.data.capacity ? String(event.data.capacity) : '');
  }, [event.data]);

  if (event.isLoading) return <Screen><LoadingState /></Screen>;

  if (event.isError) {
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
      const url = await uploadEventCover(picked.uri, id!);
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
    setSaving(true);
    try {
      await updateEvent(id!, {
        title,
        description,
        venueName,
        address,
        capacity: capacity ? Number(capacity) : null,
      });
      await event.refetch();
      setSaved(true);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  };

  const confirmCancel = () => {
    Alert.alert('Zrušiť tento event?', 'Každý, kto sa prihlásil, ho uvidí ako zrušený.', [
      { text: 'Nechať', style: 'cancel' },
      {
        text: 'Zrušiť event',
        style: 'destructive',
        onPress: async () => {
          try {
            await cancelEvent(id!);
            router.replace(`/event/${id}`);
          } catch (caught) {
            setError(messageFor(caught));
          }
        },
      },
    ]);
  };

  const confirmDelete = () => {
    Alert.alert('Zmazať natrvalo?', 'Toto sa nedá vrátiť. Zmiznú aj vstupenky a prihlášky.', [
      { text: 'Nechať', style: 'cancel' },
      {
        text: 'Zmazať',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteEvent(id!);
            router.replace('/(tabs)');
          } catch (caught) {
            setError(messageFor(caught));
          }
        },
      },
    ]);
  };

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Nepodarilo sa uložiť" body={error} /> : null}
      {saved ? <Notice tone="success" title="Uložené" body="Zmena je hneď viditeľná pre všetkých." /> : null}

      <Button title="Zmeniť titulnú fotku" variant="secondary" onPress={changeCover} disabled={saving} />

      <SectionHeader title="Detaily" />
      <Input label="Názov" value={title} onChangeText={setTitle} editable={!saving} />
      <Input
        label="Popis"
        value={description}
        onChangeText={setDescription}
        multiline
        numberOfLines={4}
        style={styles.textarea}
        editable={!saving}
      />
      <Input label="Miesto" value={venueName} onChangeText={setVenueName} editable={!saving} />
      <Input label="Adresa" value={address} onChangeText={setAddress} editable={!saving} />
      <Input
        label="Kapacita"
        value={capacity}
        onChangeText={setCapacity}
        keyboardType="number-pad"
        placeholder="Nechaj prázdne pre neobmedzenú"
        editable={!saving}
      />

      <Button title="Uložiť zmeny" onPress={save} loading={saving} />

      <Divider />

      <Button title="Zrušiť tento event" variant="danger" onPress={confirmCancel} />
      <Button title="Zmazať natrvalo" variant="ghost" onPress={confirmDelete} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  textarea: { height: 110, textAlignVertical: 'top', paddingTop: spacing.md },
});
