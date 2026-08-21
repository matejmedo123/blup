import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';

import { createCommunity } from '@/api/communities';
import { messageFor } from '@/lib/errors';
import { Body, Button, Chip, Input, Notice, Screen, SectionHeader, Switch } from '@/components/ui';
import { labelFor, spacing } from '@/theme';

const CATEGORIES = [
  'tech', 'startups', 'techno', 'indie', 'jazz', 'running', 'climbing', 'yoga',
  'hiking', 'food', 'coffee', 'wine', 'art', 'cinema', 'books', 'board-games',
  'nightlife', 'volunteering', 'wellness', 'other',
];

/** Founding a community. The founder becomes its first member. */
export default function NewCommunityScreen() {
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('other');
  const [city, setCity] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);

    if (name.trim().length < 2) {
      setError('Daj komunite názov (aspoň 2 znaky).');
      return;
    }

    const handle = (slug.trim() || name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'))
      .replace(/^-+|-+$/g, '');

    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(handle)) {
      setError('Odkaz môže mať 3–40 znakov: malé písmená, čísla a pomlčky.');
      return;
    }

    setSaving(true);
    try {
      const community = await createCommunity({
        name,
        slug: handle,
        description,
        category,
        city,
        isPrivate,
      });

      await queryClient.invalidateQueries({ queryKey: ['communities'] });
      router.replace(`/community/${community.id}`);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen scroll>
      <Body muted style={styles.intro}>
        Komunita je tematická skupina — techno, startupy, lezenie. Má vlastný feed a členov.
      </Body>

      {error ? <Notice tone="danger" title="Toto ešte oprav" body={error} /> : null}

      <Input
        label="Názov"
        value={name}
        onChangeText={(value) => {
          setName(value);
          if (!slug) setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
        }}
        placeholder="Indie music lovers"
        maxLength={60}
        editable={!saving}
      />

      <Input
        label="Odkaz"
        value={slug}
        onChangeText={(value) => setSlug(value.toLowerCase())}
        placeholder="indie-music-lovers"
        autoCapitalize="none"
        autoCorrect={false}
        hint="Používa sa v adrese komunity."
        editable={!saving}
      />

      <Input
        label="Popis"
        value={description}
        onChangeText={setDescription}
        placeholder="O čom to je a pre koho."
        multiline
        numberOfLines={3}
        maxLength={500}
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

      <Input
        label="Mesto (nepovinné)"
        value={city}
        onChangeText={setCity}
        placeholder="Bratislava"
        editable={!saving}
      />

      <Switch
        label="Súkromná komunita"
        description="Obsah uvidia len členovia."
        value={isPrivate}
        onValueChange={setIsPrivate}
      />

      <Button title="Založiť komunitu" onPress={submit} loading={saving} style={styles.submit} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { marginBottom: spacing.lg },
  textarea: { height: 90, textAlignVertical: 'top', paddingTop: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginBottom: spacing.md },
  submit: { marginTop: spacing.lg },
});
