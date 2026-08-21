import React, { useMemo, useState } from 'react';
import { Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming,
} from 'react-native-reanimated';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getInterests, setMyInterests } from '@/api/profiles';
import { messageFor } from '@/lib/errors';
import {
  Body, Button, Chip, ErrorState, LoadingState, Mono, Notice, Screen, Segmented,
} from '@/components/ui';
import { OnboardingShell } from '@/components/OnboardingShell';
import {
  colors, coverGradientFor, interestGroupFor, radius, shadow, spacing, typography,
} from '@/theme';
import { LinearGradient } from 'expo-linear-gradient';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const SWIPE_THRESHOLD = SCREEN_WIDTH * 0.25;

type Mode = 'swipe' | 'grid';

const MIN_INTERESTS = 3;

/** Step 2 of 3 — interests drive the interest_match component of the ranker. */
export default function OnboardingInterestsScreen() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<Mode>('swipe');
  const [cardIndex, setCardIndex] = useState(0);
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

  const flat = interests ?? [];
  const current = flat[cardIndex];

  const decide = (keep: boolean) => {
    const interest = flat[cardIndex];
    if (interest && keep) {
      setSelected((previous) => new Set(previous).add(interest.id));
    }
    setCardIndex((previous) => Math.min(previous + 1, flat.length));
  };

  return (
    <OnboardingShell
      step={1}
      title="Čo ťa baví?"
      subtitle={`Vyber aspoň ${MIN_INTERESTS}. AI podľa nich vyberá tvoje eventy — kedykoľvek ich vieš zmeniť.`}
      ctaLabel={
        selected.size >= MIN_INTERESTS
          ? `Pokračovať s ${selected.size}`
          : `Vyber ešte ${MIN_INTERESTS - selected.size}`
      }
      onCta={submit}
      ctaLoading={saving}
      ctaDisabled={selected.size < MIN_INTERESTS}
    >

      <Segmented
        options={[
          { value: 'swipe' as Mode, label: 'Swipovať' },
          { value: 'grid' as Mode, label: 'Zoznam' },
        ]}
        value={mode}
        onChange={setMode}
        style={styles.modeSwitch}
      />

      {error ? <Notice tone="warning" title="Ešte kúsok" body={error} /> : null}

      {mode === 'swipe' ? (
        <View style={styles.deck}>
          {current ? (
            <>
              <InterestCard
                key={current.id}
                emoji={current.emoji ?? '✨'}
                name={current.name}
                group={interestGroupFor(current.category)}
                seed={current.id}
                onDecide={decide}
              />

              <Mono style={styles.deckProgress}>
                {cardIndex + 1} / {flat.length} · vybraných {selected.size}
              </Mono>

              <View style={styles.deckActions}>
                <Pressable
                  onPress={() => decide(false)}
                  accessibilityLabel="Nezaujíma ma"
                  style={styles.deckButton}
                >
                  <Text style={styles.deckGlyph}>✕</Text>
                </Pressable>
                <Pressable
                  onPress={() => decide(true)}
                  accessibilityLabel="Baví ma to"
                  style={[styles.deckButton, styles.deckButtonYes]}
                >
                  <Text style={[styles.deckGlyph, styles.deckGlyphYes]}>♥</Text>
                </Pressable>
              </View>

              <Mono style={styles.deckHint}>doľava nie · doprava áno</Mono>
            </>
          ) : (
            <View style={styles.deckDone}>
              <Text style={styles.deckDoneEmoji}>✅</Text>
              <Body muted style={styles.deckDoneText}>
                Prešiel si všetky. Vybral si {selected.size}.
              </Body>
              <Button
                title="Prezrieť zoznam"
                variant="secondary"
                onPress={() => setMode('grid')}
              />
            </View>
          )}
        </View>
      ) : null}

      {mode === 'grid' ? grouped.map(([category, items]) => (
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
      )) : null}

    </OnboardingShell>
  );
}

/**
 * One swipeable interest card — the concept document's "swipovateľné záujmy
 * pri registrácii". Right keeps it, left skips it; the same gesture language as
 * the event deck, so the swipe means the same thing everywhere in the app.
 */
function InterestCard({
  emoji, name, group, seed, onDecide,
}: {
  emoji: string;
  name: string;
  group: string;
  seed: string;
  onDecide: (keep: boolean) => void;
}) {
  const translateX = useSharedValue(0);
  const [start, end] = coverGradientFor(seed);

  const gesture = Gesture.Pan()
    .onUpdate((event) => {
      translateX.value = event.translationX;
    })
    .onEnd((event) => {
      if (Math.abs(event.translationX) > SWIPE_THRESHOLD || Math.abs(event.velocityX) > 800) {
        const keep = event.translationX > 0;
        translateX.value = withTiming(
          keep ? SCREEN_WIDTH : -SCREEN_WIDTH,
          { duration: 160 },
          () => {
            runOnJS(onDecide)(keep);
          },
        );
        return;
      }
      translateX.value = withSpring(0, { damping: 18 });
    });

  const cardStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { rotate: `${interpolate(translateX.value, [-SCREEN_WIDTH, 0, SCREEN_WIDTH], [-10, 0, 10])}deg` },
    ],
  }));

  const yesStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateX.value, [0, SWIPE_THRESHOLD], [0, 1], 'clamp'),
  }));

  const noStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateX.value, [-SWIPE_THRESHOLD, 0], [1, 0], 'clamp'),
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[styles.card, cardStyle]}>
        <LinearGradient
          colors={[start, end]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.cardGradient}
        >
          <Text style={styles.cardEmoji}>{emoji}</Text>
          <Text style={styles.cardName}>{name}</Text>
          <Mono style={styles.cardGroup}>{group}</Mono>
        </LinearGradient>

        <Animated.View style={[styles.stamp, styles.stampYes, yesStyle]} pointerEvents="none">
          <Text style={styles.stampText}>BAVÍ MA</Text>
        </Animated.View>
        <Animated.View style={[styles.stamp, styles.stampNo, noStyle]} pointerEvents="none">
          <Text style={styles.stampText}>NIE</Text>
        </Animated.View>
      </Animated.View>
    </GestureDetector>
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
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },

  modeSwitch: { marginBottom: spacing.lg },
  deck: { alignItems: 'center', gap: spacing.md, marginBottom: spacing.xl },
  card: {
    width: '100%',
    height: 300,
    borderRadius: radius.xxl,
    overflow: 'hidden',
    ...shadow.card,
  },
  cardGradient: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  cardEmoji: { fontSize: 72 },
  cardName: { ...typography.title, color: '#FFFFFF', textAlign: 'center' },
  cardGroup: { color: 'rgba(255,255,255,0.85)' },

  stamp: {
    position: 'absolute',
    top: 28,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 3,
    backgroundColor: colors.overlay,
  },
  stampYes: { left: spacing.xl, borderColor: colors.success, transform: [{ rotate: '-12deg' }] },
  stampNo: { right: spacing.xl, borderColor: colors.danger, transform: [{ rotate: '12deg' }] },
  stampText: { ...typography.button, color: '#FFFFFF', letterSpacing: 1 },

  deckProgress: { color: colors.textTertiary },
  deckActions: { flexDirection: 'row', gap: spacing.xl },
  deckButton: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  deckButtonYes: { backgroundColor: colors.accent, borderColor: colors.accent, ...shadow.glow },
  deckGlyph: { fontSize: 24, color: colors.textSecondary },
  deckGlyphYes: { color: '#FFFFFF' },
  deckHint: { color: colors.textTertiary },

  deckDone: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xxl },
  deckDoneEmoji: { fontSize: 44 },
  deckDoneText: { textAlign: 'center' },
  footer: { marginTop: spacing.lg },
});
