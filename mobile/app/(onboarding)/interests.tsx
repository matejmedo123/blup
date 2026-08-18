import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getInterests, setMyInterests } from '@/api/profiles';
import { messageFor } from '@/lib/errors';
import {
  Body, Button, Chip, ErrorState, LoadingState, Mono, Notice, Screen,
} from '@/components/ui';
import { colors, interestGroupFor, spacing, typography } from '@/theme';

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
      setError(`Vyber si aspoň ${MIN_INTERESTS}, nech máme s čím pracovať.`);
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

  if (isLoading) return <Screen><LoadingState label="Načítavam záujmy…" /></Screen>;

  if (isError) {
    return (
      <Screen>
        <ErrorState
          message="Zoznam záujmov sa nepodarilo načítať. Skontroluj pripojenie."
          onRetry={() => void refetch()}
        />
      </Screen>
    );
  }

  return (
    <Screen scroll contentStyle={styles.content}>
      <Mono style={styles.intro}>krok 2 z 3</Mono>
      <Body muted style={styles.introBody}>
        Podľa nich ti BLUP vyberá, čo uvidíš. Kedykoľvek ich vieš zmeniť.
      </Body>

      {error ? <Notice tone="warning" title="Ešte kúsok" body={error} /> : null}

      {grouped.map(([category, items]) => (
        <View key={category} style={styles.group}>
          <Text style={styles.groupTitle}>{interestGroupFor(category)}</Text>
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
              ? `Pokračovať s ${selected.size}`
              : `Vyber ešte ${MIN_INTERESTS - selected.size}`
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
  intro: { color: colors.textTertiary },
  introBody: { marginTop: spacing.xs, marginBottom: spacing.lg },
  group: { marginBottom: spacing.xl },
  groupTitle: {
    ...typography.label,
    color: colors.textTertiary,
    textTransform: 'uppercase',
    marginBottom: spacing.md,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  footer: { marginTop: spacing.lg },
});
