import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getInterests, setMyInterests } from '@/api/profiles';
import { messageFor } from '@/lib/errors';
import {
  Body, Button, Chip, ErrorState, LoadingState, Notice, Screen,
} from '@/components/ui';
import { colors, spacing, typography } from '@/theme';

const MIN_INTERESTS = 3;

/** Step 2 of 3 — interests drive the interest_match component of the ranker. */
export default function OnboardingInterestsScreen() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: interests, isLoading, isError, refetch } = useQuery({
    queryKey: ['interests'],
    queryFn: getInterests,
  });

  const grouped = useMemo(() => {
    const groups = new Map<string, typeof interests>();
    for (const interest of interests ?? []) {
      groups.set(interest.category, [...(groups.get(interest.category) ?? []), interest]);
    }
    return [...groups.entries()];
  }, [interests]);

  const toggle = (id: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    setError(null);

    if (selected.size < MIN_INTERESTS) {
      setError(`Pick at least ${MIN_INTERESTS} so we have something to work with.`);
      return;
    }

    setSaving(true);
    try {
      await setMyInterests([...selected]);
      router.push('/(onboarding)/location');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  };

  if (isLoading) return <Screen><LoadingState label="Loading interests…" /></Screen>;

  if (isError) {
    return (
      <Screen>
        <ErrorState
          message="Could not load the interest list. Check your connection."
          onRetry={() => void refetch()}
        />
      </Screen>
    );
  }

  return (
    <Screen scroll contentStyle={styles.content}>
      <Body muted style={styles.intro}>
        Step 2 of 3 · These shape what BLUP puts in front of you. You can change them any time.
      </Body>

      {error ? <Notice tone="warning" title="Almost" body={error} /> : null}

      {grouped.map(([category, items]) => (
        <View key={category} style={styles.group}>
          <Text style={styles.groupTitle}>{category}</Text>
          <View style={styles.chips}>
            {(items ?? []).map((interest) => (
              <Chip
                key={interest.id}
                label={`${interest.emoji ?? ''} ${interest.name}`.trim()}
                selected={selected.has(interest.id)}
                onPress={() => toggle(interest.id)}
              />
            ))}
          </View>
        </View>
      ))}

      <View style={styles.footer}>
        <Button
          title={
            selected.size >= MIN_INTERESTS
              ? `Continue with ${selected.size}`
              : `Pick ${MIN_INTERESTS - selected.size} more`
          }
          onPress={submit}
          loading={saving}
          disabled={selected.size < MIN_INTERESTS}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xxxl },
  intro: { marginBottom: spacing.lg },
  group: { marginBottom: spacing.xl },
  groupTitle: {
    ...typography.micro,
    color: colors.textTertiary,
    textTransform: 'uppercase',
    marginBottom: spacing.md,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  footer: { marginTop: spacing.lg },
});
