import { eventHref } from '@/lib/format';
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import {
  getMyOrganizations, getOrganizationEvents, getOrganizerBalance,
  createPersonalOrganization,
} from '@/api/organizations';
import { getMyEvents } from '@/api/events';
import { createBoostCheckout, getBoostPackages, waitForBoost, type BoostPackage } from '@/api/boost';
import { createPromoCode, getPromoCodes } from '@/api/promo';
import { isConfigured } from '@/lib/env';
import { isStripeModuleAvailable, STRIPE_UNAVAILABLE_MESSAGE, useStripeBridge } from '@/payments/stripe';
import { messageFor } from '@/lib/errors';
import { formatEventDate, formatMoney } from '@/lib/format';
import { BottomSheet, SheetRow } from '@/components/BottomSheet';
import { useToast } from '@/components/Toast';
import {
  Body, Button, ErrorState, IconButton, LoadingState, Notice,
} from '@/components/ui';
import { categoryFamilies, colors, familyFor, radius, spacing, typography } from '@/theme';

/**
 * Organizátor.
 *
 * Three stat tiles, the event creator's entry point, your events with their
 * numbers, and the promo tools. Boosting opens a sheet that goes through the
 * real payment gateway — the boost only starts once the webhook confirms it.
 */
export default function OrganizerScreen() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { initPaymentSheet, presentPaymentSheet } = useStripeBridge();

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [boostFor, setBoostFor] = useState<{ id: string; title: string } | null>(null);
  const [promoFor, setPromoFor] = useState<{ id: string; title: string } | null>(null);
  const [promoCode, setPromoCode] = useState<string | null>(null);

  const organizations = useQuery({
    queryKey: ['organizations', 'mine'],
    queryFn: getMyOrganizations,
  });

  const organization = organizations.data?.[0];

  const balance = useQuery({
    queryKey: ['organization', organization?.id, 'balance'],
    queryFn: () => getOrganizerBalance(organization!.id),
    enabled: Boolean(organization?.id),
  });

  const orgEvents = useQuery({
    queryKey: ['organization', organization?.id, 'events'],
    queryFn: () => getOrganizationEvents(organization!.id),
    enabled: Boolean(organization?.id),
  });

  const myEvents = useQuery({ queryKey: ['events', 'mine'], queryFn: getMyEvents });

  const packages = useQuery({ queryKey: ['boost', 'packages'], queryFn: getBoostPackages });

  // Reach and RSVP come from the events themselves; revenue from the ledger.
  // Personal events count too — somebody running free events under their own
  // name still has reach worth seeing.
  const stats = useMemo(() => {
    const seen = new Map<string, { view_count?: number | null; attendee_count?: number | null }>();
    for (const event of [...(orgEvents.data ?? []), ...(myEvents.data ?? [])]) {
      seen.set(event.id, event);
    }
    const all = [...seen.values()];
    return {
      eventCount: all.length,
      views: all.reduce((sum, event) => sum + (event.view_count ?? 0), 0),
      rsvp: all.reduce((sum, event) => sum + (event.attendee_count ?? 0), 0),
    };
  }, [orgEvents.data, myEvents.data]);

  /**
   * Three zeroes tell a first-time organizer nothing except that something is
   * broken, so the tiles wait until there is something to count. Revenue waits
   * longer still: without a verified organization there is no ledger to read,
   * and a 0,00 € beside it reads as "you earned nothing" rather than "you
   * cannot sell yet".
   */
  const showStats = stats.eventCount > 0;
  const showRevenue = Boolean(organization) && organization?.verification_status === 'verified';

  const becomeOrganizer = async () => {
    if (!profile) return;
    setError(null);
    setBusy(true);
    try {
      await createPersonalOrganization({
        id: profile.id,
        display_name: profile.display_name,
        username: profile.username,
        email: profile.email,
        city: profile.city,
      });
      await organizations.refetch();
      toast.show('Profil organizátora je založený');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Buying a boost. The server prices it and returns a PaymentIntent; the
   * native sheet takes the money; then we wait for the webhook, because the
   * sheet succeeding only means the card was accepted.
   */
  const buyBoost = async (pack: BoostPackage) => {
    if (!boostFor) return;

    setError(null);
    setBusy(true);
    try {
      const session = await createBoostCheckout(boostFor.id, pack.code);

      if (!session.payment_intent_client_secret) {
        throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');
      }

      const { error: initError } = await initPaymentSheet({
        merchantDisplayName: 'BLUP',
        paymentIntentClientSecret: session.payment_intent_client_secret,
        applePay: { merchantCountryCode: 'SK' },
        googlePay: { merchantCountryCode: 'SK', testEnv: __DEV__ },
        returnURL: 'blup://stripe-redirect',
        allowsDelayedPaymentMethods: false,
      });
      if (initError) throw new Error(initError.message);

      const { error: sheetError } = await presentPaymentSheet();
      if (sheetError) {
        if (sheetError.code === 'Canceled') {
          setBusy(false);
          return;
        }
        throw new Error(sheetError.message);
      }

      const outcome = await waitForBoost(session.boost_id);

      if (outcome === 'succeeded') {
        toast.show('Boost beží — event je zvýraznený');
      } else if (outcome === 'pending') {
        toast.show('Platba prebieha, boost sa zapne o chvíľu');
      } else {
        throw new Error('Platba neprešla. Boost sa nespustil.');
      }

      setBoostFor(null);
      await queryClient.invalidateQueries({ queryKey: ['events'] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  /** Generates a code the way the handoff does: BLUPxxx, −20 %, first 50. */
  const generatePromo = async () => {
    if (!promoFor) return;

    setError(null);
    setBusy(true);
    try {
      const code = `BLUP${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
      await createPromoCode({
        code,
        kind: 'percent',
        value: 20,
        eventId: promoFor.id,
        maxUses: 50,
      });

      setPromoCode(code);
      await queryClient.invalidateQueries({ queryKey: ['promo-codes'] });
      toast.show(`Kód ${code} je aktívny`);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  if (organizations.isLoading) {
    return <SafeAreaView style={styles.screen} edges={['top']}><LoadingState /></SafeAreaView>;
  }

  if (organizations.isError) {
    return (
      <SafeAreaView style={styles.screen} edges={['top']}>
        <ErrorState
          message={messageFor(organizations.error)}
          onRetry={() => void organizations.refetch()}
        />
      </SafeAreaView>
    );
  }

  const events = organization ? (orgEvents.data ?? []) : [];
  const personalEvents = myEvents.data ?? [];
  const currency = balance.data?.currency;

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.header}>
        <IconButton glyph="‹" size={40} onPress={() => router.back()} />
        <Text style={styles.screenTitle}>Organizátor</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {error ? <Notice tone="danger" title="Nepodarilo sa" body={error} /> : null}

        {/* --- stats --------------------------------------------------------- */}
        {showStats ? (
          <View style={styles.statRow}>
            <StatTile label="ZOBRAZENIA" value={String(stats.views)} note="za všetky eventy" />
            <StatTile label="RSVP" value={String(stats.rsvp)} note="prihlásených" />
            {showRevenue ? (
              <StatTile
                label="VÝNOS"
                value={formatMoney(balance.data?.balance_cents ?? 0, currency)}
                note="po Blup fee"
              />
            ) : null}
          </View>
        ) : null}

        {/* --- create -------------------------------------------------------- */}
        <Pressable
          style={({ pressed }) => [styles.createCard, pressed && styles.pressed]}
          onPress={() => router.push('/organizer/create')}
        >
          <View style={styles.flex}>
            <Text style={styles.createTitle}>Nový event</Text>
            <Text style={styles.createBody}>
              Názov, miesto, čas, kategória a vstupné. Po zverejnení je hneď na mape aj vo feede.
            </Text>
          </View>
          <Text style={styles.createGlyph}>＋</Text>
        </Pressable>

        {!organization ? (
          <Notice
            tone="warning"
            title="Chceš predávať vstupenky?"
            body="Eventy zdarma vieš robiť hneď. Na vstupné potrebuješ profil organizátora — založíme ti ho z tvojho profilu."
            actionLabel={busy ? 'Zakladám…' : 'Založiť to za mňa'}
            onAction={becomeOrganizer}
          />
        ) : organization.verification_status !== 'verified' ? (
          <Notice
            tone="warning"
            title="Na výplaty potrebuješ overenie"
            body="Vstupné si vieš nastaviť už teraz. Peniaze vieme vyplatiť až overenému subjektu — je to zákonná požiadavka."
            actionLabel="Požiadať o overenie"
            onAction={() => router.push('/organizer/verification')}
          />
        ) : null}

        {/* --- my events ------------------------------------------------------ */}
        <Text style={styles.section}>Moje eventy</Text>

        {personalEvents.length === 0 ? (
          <View style={styles.empty}>
            <Body muted>Zatiaľ si nič nezverejnil. Prvý event zaberie minútu.</Body>
          </View>
        ) : (
          personalEvents.map((event) => {
            const family = categoryFamilies[familyFor(event.category)];
            const orgRow = events.find((item) => item.id === event.id);

            return (
              <View key={event.id} style={styles.eventCard}>
                <Pressable
                  style={styles.eventTop}
                  onPress={() => router.push(eventHref(event))}
                >
                  <View style={[styles.dot, { backgroundColor: family.color }]} />
                  <View style={styles.flex}>
                    <Text style={styles.eventTitle} numberOfLines={1}>{event.title}</Text>
                    <Text style={styles.eventMeta}>
                      {formatEventDate(event.start_at)}
                      {orgRow ? ` · ${orgRow.attendee_count} ide` : ''}
                      {orgRow?.view_count ? ` · ${orgRow.view_count} zobrazení` : ''}
                    </Text>
                  </View>
                  <Text style={styles.eventPrice}>
                    {event.is_free ? 'Zdarma' : formatMoney(event.price_cents, event.currency)}
                  </Text>
                </Pressable>

                <View style={styles.eventActions}>
                  <Pressable
                    style={styles.eventAction}
                    onPress={() => router.push(`/organizer/analytics/${event.id}`)}
                  >
                    <Text style={styles.eventActionLabel}>Štatistiky</Text>
                  </Pressable>

                  {!event.is_free ? (
                    <Pressable
                      style={styles.eventAction}
                      onPress={() => router.push(`/organizer/tickets/${event.id}`)}
                    >
                      <Text style={styles.eventActionLabel}>Vstupenky</Text>
                    </Pressable>
                  ) : null}

                  <Pressable
                    style={styles.eventAction}
                    onPress={() => {
                      setPromoCode(null);
                      setPromoFor({ id: event.id, title: event.title });
                    }}
                  >
                    <Text style={styles.eventActionLabel}>Promo kód</Text>
                  </Pressable>

                  <Pressable
                    onPress={() => setBoostFor({ id: event.id, title: event.title })}
                    style={styles.boostAction}
                  >
                    <LinearGradient
                      colors={[colors.orange, colors.pink]}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 0 }}
                      style={styles.boostGradient}
                    >
                      <Text style={styles.boostLabel}>Boostnúť</Text>
                    </LinearGradient>
                  </Pressable>
                </View>
              </View>
            );
          })
        )}

        {/* --- money ---------------------------------------------------------- */}
        {organization ? (
          <>
            <Text style={styles.section}>Tvoja značka</Text>
            <Button
              title="Verejný profil a logo"
              variant="secondary"
              full
              onPress={() => router.push('/organizer/profile')}
            />

            <Text style={styles.section}>Peniaze</Text>
            <View style={styles.moneyRow}>
              <Button
                title="Zostatok a výplaty"
                variant="secondary"
                onPress={() => router.push('/organizer/payouts')}
                style={styles.flex}
              />
              <Button
                title="Účtovníctvo"
                variant="secondary"
                onPress={() => router.push('/organizer/accounting')}
                style={styles.flex}
              />
            </View>

            {/* The scanner is the door, not the money — and there is nothing to
                scan until this organization can sell, so it waits for that. */}
            {showRevenue ? (
              <>
                <Text style={styles.section}>Pri vstupe</Text>
                <Button
                  title="Skener vstupeniek"
                  variant="secondary"
                  full
                  onPress={() => router.push('/organizer/scan')}
                />
              </>
            ) : null}
          </>
        ) : null}
      </ScrollView>

      {/* --- boost sheet ------------------------------------------------------ */}
      <BottomSheet
        visible={Boolean(boostFor)}
        onClose={() => setBoostFor(null)}
        title="Boostnúť event"
        subtitle={boostFor?.title}
        footer={
          <Body muted style={styles.sheetNote}>
            Boost sa spustí až keď platbu potvrdí banka. V zozname bude event označený ako
            sponzorovaný — promo, ktoré sa netají tým, že je promo.
          </Body>
        }
      >
        {!isStripeModuleAvailable ? (
          <Notice
            tone="warning"
            title="Platby potrebujú development build"
            body={STRIPE_UNAVAILABLE_MESSAGE}
          />
        ) : !isConfigured.stripe ? (
          <Notice
            tone="warning"
            title="Platby nie sú nakonfigurované"
            body="Tento build nemá Stripe kľúč, takže platobný formulár sa nedá otvoriť."
          />
        ) : null}

        {(packages.data ?? []).map((pack) => (
          <Pressable
            key={pack.code}
            disabled={busy || !isConfigured.stripe || !isStripeModuleAvailable}
            onPress={() => buyBoost(pack)}
            style={({ pressed }) => [styles.package, pressed && styles.pressed]}
          >
            <View style={styles.flex}>
              <Text style={styles.packageName}>{pack.name}</Text>
              <Text style={styles.packageMeta}>
                +{Math.round(pack.weight * 100)} bodov vo výbere · {pack.hours} h
              </Text>
            </View>
            <Text style={styles.packagePrice}>
              {formatMoney(pack.price_cents, pack.currency)}
            </Text>
          </Pressable>
        ))}
      </BottomSheet>

      {/* --- promo sheet ------------------------------------------------------ */}
      <BottomSheet
        visible={Boolean(promoFor)}
        onClose={() => setPromoFor(null)}
        title="Promo kód"
        subtitle={promoFor?.title}
        footer={
          <View style={styles.sheetActions}>
            {/* The editor first: it is the one that lets an organizer pick their
                own code and their own discount. The quick one below stays
                because "give me a code, now" is a real thing to want, but it
                is no longer the only door — you used to have to generate a
                hardcoded −20 % before you could reach the screen that changes
                it. */}
            <Button
              title="Nastaviť si vlastný"
              onPress={() => {
                const id = promoFor?.id;
                setPromoFor(null);
                if (id) router.push(`/organizer/promo/${id}`);
              }}
              large
              style={styles.flex}
            />
            <Button
              title={busy ? 'Vytváram…' : 'Rýchly −20 %'}
              variant="secondary"
              onPress={generatePromo}
              loading={busy}
              large
              style={styles.flex}
            />
          </View>
        }
      >
        <Body muted style={styles.sheetIntro}>
          Vlastný kód, vlastné percento, vlastný počet použití — alebo si nechaj
          vygenerovať jeden hotový.
        </Body>
        <SheetRow label="Rýchly kód" value="−20 %, prvých 50 ľudí" />
        <SheetRow label="Zľavu platí" value="organizátor" tone="muted" />

        {promoCode ? (
          <Notice
            tone="success"
            title={`Aktívny kód: ${promoCode}`}
            body="−20 % pre prvých 50 ľudí. Kód vieš vypnúť v detaile promo kódov."
            actionLabel="Spravovať kódy"
            onAction={() => {
              const id = promoFor?.id;
              setPromoFor(null);
              if (id) router.push(`/organizer/promo/${id}`);
            }}
          />
        ) : null}
      </BottomSheet>
    </SafeAreaView>
  );
}

function StatTile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <View style={styles.statTile}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      <Text style={styles.statNote}>{note}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.9 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.gutter,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
  },
  screenTitle: { ...typography.screenTitle, color: colors.text },
  content: { paddingHorizontal: spacing.gutter, paddingBottom: spacing.xxxl },

  statRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.xl },
  statTile: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  statLabel: { ...typography.monoSm, color: colors.textMuted },
  statValue: { ...typography.heading, color: colors.text },
  statNote: { ...typography.monoSm, color: colors.cyan },

  createCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
    marginBottom: spacing.lg,
  },
  createTitle: { ...typography.subheading, color: colors.text },
  createBody: { ...typography.metaSm, color: colors.textTertiary, marginTop: 3 },
  createGlyph: { fontSize: 26, color: colors.accent },

  // Centred to sit over the controls beneath them, which are themselves capped
  // and centred — a left-aligned heading over a centred row reads as two
  // different columns on a wide screen.
  section: {
    ...typography.heading,
    color: colors.text,
    marginTop: spacing.xl,
    marginBottom: spacing.md,
    textAlign: 'center',
    alignSelf: 'center',
    width: '100%',
    maxWidth: 520,
  },

  empty: {
    padding: spacing.xl,
    borderRadius: radius.card,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
  },

  eventCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
    gap: spacing.md,
  },
  eventTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  dot: { width: 10, height: 10, borderRadius: 5 },
  eventTitle: { ...typography.rowTitle, color: colors.text },
  eventMeta: { ...typography.metaSm, color: colors.textTertiary, marginTop: 2 },
  eventPrice: { ...typography.meta, color: colors.cyan },

  eventActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  eventAction: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 9,
    borderRadius: radius.chip,
    backgroundColor: colors.surfaceElevated,
  },
  eventActionLabel: { ...typography.chip, color: colors.textSecondary },
  boostAction: { borderRadius: radius.chip, overflow: 'hidden' },
  boostGradient: { paddingHorizontal: spacing.lg, paddingVertical: 9 },
  boostLabel: { ...typography.chip, color: '#FFFFFF' },

  sheetIntro: { marginBottom: spacing.md },
  moneyRow: { flexDirection: 'row', gap: spacing.md, width: '100%', maxWidth: 520, alignSelf: 'center' },

  package: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    backgroundColor: colors.surfaceInput,
    borderRadius: radius.block,
    padding: spacing.lg,
  },
  packageName: { ...typography.rowTitle, color: colors.text },
  packageMeta: { ...typography.metaSm, color: colors.textTertiary, marginTop: 2 },
  packagePrice: { ...typography.subheading, color: colors.orange },

  sheetNote: { ...typography.caption },
  sheetActions: { flexDirection: 'row', gap: spacing.md },
});
