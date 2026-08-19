import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from './ui';
import { colors, spacing, typography } from '@/theme';

/**
 * The onboarding shell from the handoff.
 *
 * `linear-gradient(180deg, #0A2B54 0%, #0A0D12 62%)`, 26px gutters, content
 * centred and the CTA pinned to the bottom with a "Preskočiť" under it. Every
 * step of the flow wears this so the sequence reads as one screen changing.
 */
export function OnboardingShell({
  step,
  title,
  subtitle,
  children,
  ctaLabel,
  onCta,
  ctaLoading,
  ctaDisabled,
  onSkip,
  skipLabel = 'Preskočiť',
}: {
  /** 0-based index; renders the three progress pips. */
  step?: number;
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
  ctaLabel: string;
  onCta: () => void;
  ctaLoading?: boolean;
  ctaDisabled?: boolean;
  onSkip?: () => void;
  skipLabel?: string;
}) {
  return (
    <LinearGradient colors={['#0A2B54', '#0A0D12', '#0A0D12']} locations={[0, 0.62, 1]} style={styles.gradient}>
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {typeof step === 'number' ? (
            <View style={styles.pips}>
              {[0, 1, 2].map((index) => (
                <View key={index} style={[styles.pip, index === step && styles.pipActive]} />
              ))}
            </View>
          ) : null}

          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}

          <View style={styles.body}>{children}</View>
        </ScrollView>

        <View style={styles.footer}>
          <Button
            title={ctaLabel}
            onPress={onCta}
            loading={ctaLoading}
            disabled={ctaDisabled}
            large
          />

          {onSkip ? (
            <Pressable onPress={onSkip} style={styles.skip} hitSlop={10}>
              <Text style={styles.skipLabel}>{skipLabel}</Text>
            </Pressable>
          ) : null}
        </View>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  gradient: { flex: 1 },
  safe: { flex: 1 },
  content: {
    flexGrow: 1,
    paddingHorizontal: spacing.gutterWide,
    paddingTop: spacing.xxxl,
    paddingBottom: spacing.xl,
  },

  pips: { flexDirection: 'row', gap: 6, marginBottom: spacing.xxl },
  pip: { width: 22, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)' },
  pipActive: { backgroundColor: colors.accent },

  title: { ...typography.onboardH2, color: colors.text },
  subtitle: {
    ...typography.body,
    color: colors.textTertiary,
    marginTop: spacing.md,
    maxWidth: 300,
  },
  body: { marginTop: spacing.xxl, flex: 1 },

  footer: {
    paddingHorizontal: spacing.gutterWide,
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  skip: { alignSelf: 'center' },
  skipLabel: { ...typography.meta, color: colors.textQuaternary },
});
