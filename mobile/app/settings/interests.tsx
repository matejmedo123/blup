import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getInterests, getMyInterests, setMyInterests } from '@/api/profiles';
import { messageFor } from '@/lib/errors';
import { Body, Button, Chip, LoadingState, Notice, Screen } from '@/components/ui';
import { colors, spacing, typography } from '@/theme';

export default function InterestsSettingsScreen() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const interests = useQuery({ queryKey: ['interests'], queryFn: getInterests });
  const mine = useQuery({ queryKey: ['interests', 'mine'], queryFn: getMyInterests });

  useEffect(() => {
    if (mine.data) setSelected(new Set(mine.data));
  }, [mine.data]);

  const grouped = useMemo(() => {
    const groups = new Map<string, typeof interests.data>();
    for (const interest of interests.data ?? []) {
      groups.set(interest.category, [...(groups.get(interest.category) ?? []), interest]);
    }
    return [...groups.entries()];
  }, [interests.data]);

  const save = async () => {
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      await setMyInterests([...selected]);
      setSaved(true);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  };

  if (interests.isLoading || mine.isLoading) return <Screen><LoadingState /></Screen>;

  return (
    <Screen scroll>
      <Body muted style={styles.intro}>
        These feed the recommendation ranker directly — the more accurate they are, the better your
        feed gets.
      </Body>

      {error ? <Notice tone="danger" title="Could not save" body={error} /> : null}
      {saved ? <Notice tone="success" title="Saved" body="Your feed will update on the next refresh." /> : null}

      {grouped.map(([category, items]) => (
        <View key={category} style={styles.group}>
          <Text style={styles.groupTitle}>{category}</Text>
          <View style={styles.chips}>
            {(items ?? []).map((interest) => (
              <Chip
                key={interest.id}
                label={`${interest.emoji ?? ''} ${interest.name}`.trim()}
                selected={selected.has(interest.id)}
                onPress={() =>
                  setSelected((previous) => {
                    const next = new Set(previous);
                    if (next.has(interest.id)) next.delete(interest.id);
                    else next.add(interest.id);
                    return next;
                  })
                }
              />
            ))}
          </View>
        </View>
      ))}

      <Button title={`Save ${selected.size} interests`} onPress={save} loading={saving} />
      <Button title="Back" variant="ghost" onPress={() => router.back()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { marginBottom: spacing.lg },
  group: { marginBottom: spacing.xl },
  groupTitle: {
    ...typography.micro,
    color: colors.textTertiary,
    textTransform: 'uppercase',
    marginBottom: spacing.md,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
