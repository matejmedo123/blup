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
    Alert.alert('Cancel this event?', 'Everyone who RSVP’d will see it as cancelled.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Cancel event',
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
    Alert.alert('Delete permanently?', 'This cannot be undone. Tickets and RSVPs go with it.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Delete',
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
      {error ? <Notice tone="danger" title="Could not save" body={error} /> : null}
      {saved ? <Notice tone="success" title="Saved" body="Everyone sees the update immediately." /> : null}

      <Button title="Change cover photo" variant="secondary" onPress={changeCover} disabled={saving} />

      <SectionHeader title="Details" />
      <Input label="Title" value={title} onChangeText={setTitle} editable={!saving} />
      <Input
        label="Description"
        value={description}
        onChangeText={setDescription}
        multiline
        numberOfLines={4}
        style={styles.textarea}
        editable={!saving}
      />
      <Input label="Venue" value={venueName} onChangeText={setVenueName} editable={!saving} />
      <Input label="Address" value={address} onChangeText={setAddress} editable={!saving} />
      <Input
        label="Capacity"
        value={capacity}
        onChangeText={setCapacity}
        keyboardType="number-pad"
        placeholder="Leave empty for unlimited"
        editable={!saving}
      />

      <Button title="Save changes" onPress={save} loading={saving} />

      <Divider />

      <Button title="Cancel this event" variant="danger" onPress={confirmCancel} />
      <Button title="Delete permanently" variant="ghost" onPress={confirmDelete} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  textarea: { height: 110, textAlignVertical: 'top', paddingTop: spacing.md },
});
