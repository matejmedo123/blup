import React, { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getPremiumStatus, getStore, PREMIUM_FEATURES, purchasePremium, restorePurchases,
} from '@/api/premium';
import { messageFor } from '@/lib/errors';
import {
  Badge, Body, Button, Caption, Divider, LoadingState, Notice, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Premium.
 *
 * On iOS this must go through StoreKit (Apple's rules for digital goods), so the
 * purchase button drives the native store and the receipt is verified by the
 * backend before anything unlocks. When the native module is absent the screen
 * says exactly that instead of showing a button that does nothing.
 */
export default function PremiumScreen() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const status = useQuery({ queryKey: ['premium', 'status'], queryFn: getPremiumStatus });
  const store = getStore();

  const buy = async (plan: 'monthly' | 'yearly') => {
    setError(null);
    setBusy(plan);
    try {
      await purchasePremium(plan);
      await queryClient.invalidateQueries({ queryKey: ['premium'] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    setError(null);
    setBusy('restore');
    try {
      await restorePurchases();
      await queryClient.invalidateQueries({ queryKey: ['premium'] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  if (status.isLoading) return <Screen><LoadingState /></Screen>;

  const isPremium = status.data?.is_premium ?? false;

  return (
    <Screen scroll>
      <View style={styles.hero}>
        <Text style={styles.heroEmoji}>✨</Text>
        <Text style={styles.heroTitle}>BLUP Premium</Text>
        <Body muted style={styles.heroBody}>
          Lepší objav, viac kontroly a celý príbeh za každým odporúčaním.
        </Body>
        {isPremium ? <Badge tone="success" label="AKTÍVNE" /> : null}
      </View>

      {error ? <Notice tone="danger" title="Nepodarilo sa dokončiť" body={error} /> : null}

      {isPremium ? (
        <Notice
          tone="success"
          title="Máš Premium"
          body={
            status.data?.expires_at
              ? `${status.data.auto_renew ? 'Obnoví sa' : 'Vyprší'} ${new Date(status.data.expires_at).toLocaleDateString('sk-SK')}.`
              : 'Tvoje predplatné je aktívne.'
          }
        />
      ) : null}

      <SectionHeader title="Čo z toho máš" />
      {PREMIUM_FEATURES.map((feature) => (
        <View key={feature} style={styles.feature}>
          <Text style={styles.featureCheck}>✓</Text>
          <Body style={styles.flex}>{feature}</Body>
        </View>
      ))}

      <Divider />

      {!store.available ? (
        <Notice
          tone="warning"
          title={
            store.reason === 'UNSUPPORTED_PLATFORM'
              ? 'Na tejto platforme nedostupné'
              : 'Nákupy v aplikácii nie sú v tomto builde nastavené'
          }
          body={store.message}
        />
      ) : null}

      {!isPremium ? (
        <>
          <View style={styles.plans}>
            <View style={styles.plan}>
              <Text style={styles.planName}>Mesačne</Text>
              <Caption>Zrušíš kedykoľvek</Caption>
              <Button
                title="Predplatiť"
                onPress={() => buy('monthly')}
                loading={busy === 'monthly'}
                disabled={!store.available || busy !== null}
                style={styles.planButton}
              />
            </View>

            <View style={[styles.plan, styles.planFeatured]}>
              <Badge tone="accent" label="NAJVÝHODNEJŠIE" />
              <Text style={styles.planName}>Ročne</Text>
              <Caption>Dva mesiace zadarmo</Caption>
              <Button
                title="Predplatiť"
                onPress={() => buy('yearly')}
                loading={busy === 'yearly'}
                disabled={!store.available || busy !== null}
                style={styles.planButton}
              />
            </View>
          </View>

          <Button
            title="Obnoviť nákupy"
            variant="ghost"
            onPress={restore}
            loading={busy === 'restore'}
            disabled={!store.available}
          />
        </>
      ) : null}

      <Caption style={styles.legal}>
        {Platform.OS === 'ios'
          ? 'Billed through your Apple ID. Manage or cancel in Settings → Apple ID → Subscriptions. ' +
            'Every purchase is verified with Apple on our servers before Premium unlocks.'
          : 'Billed through Google Play. Manage or cancel in the Play Store. ' +
            'Every purchase is verified on our servers before Premium unlocks.'}
      </Caption>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  hero: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xl },
  heroEmoji: { fontSize: 48 },
  heroTitle: { ...typography.title, color: colors.text },
  heroBody: { textAlign: 'center', maxWidth: 300 },

  feature: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start', marginBottom: spacing.md },
  featureCheck: { ...typography.bodyStrong, color: colors.success },

  plans: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.lg },
  plan: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
  },
  planFeatured: { borderColor: colors.accent },
  planName: { ...typography.subheading, color: colors.text },
  planButton: { marginTop: spacing.md },

  legal: { textAlign: 'center', marginTop: spacing.xl, lineHeight: 18 },
});
