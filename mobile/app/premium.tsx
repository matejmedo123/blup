import React, { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getPremiumStatus, getStore, getWebPremiumPricing, getWebPremiumStatus, PREMIUM_FEATURES,
  purchasePremium, restorePurchases,
} from '@/api/premium';
import {
  canManageBilling, openBillingPortal, subscribePremium,
} from '@/payments/checkout';
import { messageFor } from '@/lib/errors';
import {
  Badge, Body, Button, Caption, Divider, LoadingState, Notice, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Premium.
 *
 * On iOS this must go through StoreKit — Apple's rules for digital goods — so
 * the purchase button drives the native store and the receipt is verified by
 * the backend before anything unlocks.
 *
 * In a browser there is no such rule and no 15–30 % commission, so the same
 * subscription is sold through Stripe at the same shelf price. Both write to
 * one table, so somebody who subscribes on the web keeps Premium when they
 * later install the app — and is never charged twice.
 */
/**
 * The amount, formatted — or nothing at all.
 *
 * Showing a guessed price next to a subscribe button is worse than showing
 * none: whatever appears here is what the card is charged, so it comes from
 * the server or it does not appear.
 */
function priceLabel(price?: { amount_cents: number | null; currency: string } | null): string | null {
  if (!price || price.amount_cents == null) return null;
  return new Intl.NumberFormat('sk-SK', {
    style: 'currency',
    currency: price.currency || 'EUR',
  }).format(price.amount_cents / 100);
}

export default function PremiumScreen() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const status = useQuery({ queryKey: ['premium', 'status'], queryFn: getPremiumStatus });
  const web = useQuery({
    queryKey: ['premium', 'web-status'],
    queryFn: getWebPremiumStatus,
    enabled: canManageBilling,
  });
  const pricing = useQuery({
    queryKey: ['premium', 'web-pricing'],
    queryFn: getWebPremiumPricing,
    enabled: canManageBilling,
    staleTime: 10 * 60 * 1000,
  });
  const store = getStore();

  // In a browser the store is Stripe, not Apple; the native-store warning below
  // would be both wrong and confusing there.
  const canBuy = canManageBilling ? true : store.available;

  const buy = async (plan: 'monthly' | 'yearly') => {
    setError(null);
    setBusy(plan);
    try {
      if (canManageBilling) {
        // Web: hand off to Stripe. The browser navigates away, so there is
        // nothing to invalidate here — the subscription is written by the
        // webhook and read fresh when the user comes back.
        await subscribePremium(plan);
        return;
      }
      await purchasePremium(plan);
      await queryClient.invalidateQueries({ queryKey: ['premium'] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  /** Stripe's own page for changing a card or cancelling. */
  const manage = async () => {
    setError(null);
    setBusy('portal');
    try {
      await openBillingPortal();
    } catch (caught) {
      setError(messageFor(caught));
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

      {!canManageBilling && !store.available ? (
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
              {priceLabel(pricing.data?.monthly) ? (
                <Text style={styles.planPrice}>{priceLabel(pricing.data?.monthly)}</Text>
              ) : null}
              <Caption>Zrušíš kedykoľvek</Caption>
              <Button
                title="Predplatiť"
                onPress={() => buy('monthly')}
                loading={busy === 'monthly'}
                disabled={!canBuy || busy !== null}
                style={styles.planButton}
              />
            </View>

            <View style={[styles.plan, styles.planFeatured]}>
              <Badge tone="accent" label="NAJVÝHODNEJŠIE" />
              <Text style={styles.planName}>Ročne</Text>
              {priceLabel(pricing.data?.yearly) ? (
                <Text style={styles.planPrice}>{priceLabel(pricing.data?.yearly)}</Text>
              ) : null}
              <Caption>Dva mesiace zadarmo</Caption>
              <Button
                title="Predplatiť"
                onPress={() => buy('yearly')}
                loading={busy === 'yearly'}
                disabled={!canBuy || busy !== null}
                style={styles.planButton}
              />
            </View>
          </View>

          {canManageBilling ? (
            <Caption style={styles.legal}>
              Platba prebehne na zabezpečenej stránke Stripe. Zrušiť sa dá kedykoľvek — Premium ti
              beží do konca zaplateného obdobia.
            </Caption>
          ) : (
            <Button
              title="Obnoviť nákupy"
              variant="ghost"
              onPress={restore}
              loading={busy === 'restore'}
              disabled={!store.available}
            />
          )}
        </>
      ) : null}

      {/* Managing an existing subscription — only where it was actually bought. */}
      {isPremium && canManageBilling ? (
        web.data?.managed_here ? (
          <Button
            title="Predplatné"
            variant="secondary"
            loading={busy === 'portal'}
            onPress={() => void manage()}
          />
        ) : (
          <Notice
            tone="accent"
            title="Predplatné máš z App Store"
            body="Zmeniť kartu alebo zrušiť sa dá len tam: Nastavenia → Apple ID → Predplatné. Odtiaľto do toho nevidíme."
          />
        )
      ) : null}

      <Caption style={styles.legal}>
        {canManageBilling
          ? 'Účtuje sa cez Stripe. Faktúry, zmena karty aj zrušenie sú v „Spravovať predplatné“. ' +
            'Premium sa odomkne, až keď platbu potvrdí banka.'
          : Platform.OS === 'ios'
          ? 'Účtuje sa cez tvoje Apple ID. Spravuješ alebo rušíš v Nastavenia → Apple ID → Predplatné. ' +
            'Každý nákup overujeme u Apple na našich serveroch, až potom sa Premium odomkne.'
          : 'Účtuje sa cez Google Play. Spravuješ alebo rušíš v Play Store. ' +
            'Každý nákup overujeme na našich serveroch, až potom sa Premium odomkne.'}
      </Caption>
    </Screen>
  );
}

const styles = StyleSheet.create({
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
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
  planPrice: { ...typography.heading, color: colors.text },
  planName: { ...typography.subheading, color: colors.text },
  planButton: { marginTop: spacing.md },

  legal: { textAlign: 'center', marginTop: spacing.xl, lineHeight: 18 },
});
