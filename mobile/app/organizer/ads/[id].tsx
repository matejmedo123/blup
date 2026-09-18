import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getEvent } from '@/api/events';
import {
  getAdAudience, getAdQuote, getBoostPackages, getBoostQuote, getBoostReport, getEventBoosts,
  setAdPaused, waitForBoost, type BoostPlacement, type BoostQuote, type EventBoost,
} from '@/api/boost';
import { payForBoost, payForCampaign } from '@/payments/checkout';
import { isStripeModuleAvailable, STRIPE_UNAVAILABLE_MESSAGE, useStripeBridge } from '@/payments/stripe';
import { isConfigured } from '@/lib/env';
import { messageFor } from '@/lib/errors';
import { formatEventDate, formatMoney } from '@/lib/format';
import { useToast } from '@/components/Toast';
import {
  Button, Caption, Chip, Input, LoadingState, Notice, Panel, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Reklama na BLUPe.
 *
 * Until now "advertising" was three fixed buttons: 24 hours, 48 hours, a week.
 * The delivery side had always been a real ad system — a budget in impressions,
 * pacing, an auction, a relevance floor, a frequency cap — but the buying side
 * could not express anything. `event_boosts.target_radius_m` and
 * `target_categories` had existed since the delivery engine was written and
 * NOTHING EVER SET THEM.
 *
 * So this screen is the buying side: your budget, your audience, your dates.
 *
 * The one thing it refuses to do is flatter. The reach figure is people, not
 * impressions; next to it sits how many of those people have actually opened
 * BLUP in the last month, because that is the number that resembles delivery.
 * Everything priced here is priced by the database — the app sends what you
 * chose, never what it costs.
 */

const BUDGET_PRESETS = [1000, 2500, 5000, 10000];
const DAY_PRESETS = [3, 7, 14, 30];
const RADIUS_PRESETS = [5000, 15000, 30000, 60000, 120000];

const CATEGORIES: { value: string; label: string }[] = [
  { value: 'music', label: 'Hudba' },
  { value: 'nightlife', label: 'Nočný život' },
  { value: 'sport', label: 'Šport' },
  { value: 'outdoor', label: 'Outdoor' },
  { value: 'culture', label: 'Kultúra' },
  { value: 'food', label: 'Jedlo a pitie' },
  { value: 'business', label: 'Biznis' },
  { value: 'social', label: 'Spoločenské' },
  { value: 'wellness', label: 'Wellness' },
];

const PLACEMENTS: { value: BoostPlacement; label: string; note: string }[] = [
  { value: 'feed', label: 'Feed', note: 'V zozname eventov, označené ako sponzorované.' },
  { value: 'map', label: 'Mapa', note: 'Zvýraznený bod na mape.' },
  { value: 'spotlight', label: 'Spotlight', note: 'Veľká karta navrchu. Jedna denne na človeka.' },
];

function kilometres(metres: number): string {
  return `${Math.round(metres / 1000)} km`;
}

export default function AdsScreen() {
  const { id, paid } = useLocalSearchParams<{ id: string; paid?: string }>();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { initPaymentSheet, presentPaymentSheet } = useStripeBridge();

  const [budget, setBudget] = React.useState('25');
  const [days, setDays] = React.useState(7);
  const [radiusM, setRadiusM] = React.useState(30000);
  const [categories, setCategories] = React.useState<string[]>([]);
  const [placements, setPlacements] = React.useState<BoostPlacement[]>(['feed']);
  const [error, setError] = React.useState<string | null>(null);
  const [buying, setBuying] = React.useState(false);
  const [buyingPackage, setBuyingPackage] = React.useState<string | null>(null);
  const [pausing, setPausing] = React.useState<string | null>(null);

  // Cents, from whatever was typed. A comma is what a Slovak keyboard offers
  // for a decimal point, so it has to mean the same thing.
  const budgetCents = React.useMemo(() => {
    const parsed = Number.parseFloat(budget.replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.round(parsed * 100);
  }, [budget]);

  const event = useQuery({
    queryKey: ['event', id],
    queryFn: () => getEvent(id!),
    enabled: Boolean(id),
  });

  const boosts = useQuery({
    queryKey: ['boosts', id],
    queryFn: () => getEventBoosts(id!),
    enabled: Boolean(id),
  });

  const report = useQuery({
    queryKey: ['boost-report', id],
    queryFn: () => getBoostReport(id!),
    enabled: Boolean(id),
  });

  // The estimate is what the screen is for, so it follows every change to the
  // audience — but not every keystroke of the budget, which does not affect it.
  const audience = useQuery({
    queryKey: ['ad-audience', id, radiusM, categories.join(',')],
    queryFn: () => getAdAudience(id!, radiusM, categories),
    enabled: Boolean(id),
    placeholderData: (previous) => previous,
  });

  const packages = useQuery({ queryKey: ['boost-packages'], queryFn: getBoostPackages });

  // Priced per package for THIS event, because a boost is cut short at the end
  // of the event and the price does not follow it down. The organizer has to be
  // told that before they pay, not after.
  const packageQuotes = useQuery({
    queryKey: ['boost-quotes', id],
    queryFn: async () => {
      const pairs = await Promise.all((packages.data ?? []).map(async (pack) => {
        try {
          return [pack.code, await getBoostQuote(id!, pack.code)] as const;
        } catch {
          return null;
        }
      }));
      return Object.fromEntries(
        pairs.filter((pair): pair is readonly [string, BoostQuote] => pair !== null),
      ) as Record<string, BoostQuote>;
    },
    enabled: Boolean(id) && (packages.data ?? []).length > 0,
  });

  const quote = useQuery({
    queryKey: ['ad-quote', budgetCents],
    queryFn: () => getAdQuote(budgetCents),
    enabled: budgetCents >= 500,
    placeholderData: (previous) => previous,
  });

  const togglePlacement = (value: BoostPlacement) => {
    setPlacements((current) => (
      current.includes(value)
        // Never empty: a campaign with nowhere to appear is not a campaign, and
        // the database refuses it anyway.
        ? (current.length === 1 ? current : current.filter((p) => p !== value))
        : [...current, value]
    ));
  };

  const toggleCategory = (value: string) => {
    setCategories((current) => (
      current.includes(value) ? current.filter((c) => c !== value) : [...current, value]
    ));
  };

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['boosts', id] }),
      queryClient.invalidateQueries({ queryKey: ['boost-report', id] }),
    ]);
  };

  const buy = async () => {
    if (!id) return;
    setError(null);

    if (budgetCents < 500) {
      setError('Najmenší rozpočet je 5 €.');
      return;
    }

    setBuying(true);
    try {
      const session = await payForCampaign({
        eventId: id,
        budgetCents,
        days,
        placements,
        radiusM,
        categories,
      });

      // Web: the browser is already on its way to Stripe's page. Nothing more
      // happens here, and the campaign goes live when the webhook says so.
      if (session.status === 'redirecting') return;

      const clientSecret = 'clientSecret' in session ? session.clientSecret : undefined;
      if (!clientSecret) throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');

      const { error: initError } = await initPaymentSheet({
        merchantDisplayName: 'BLUP',
        paymentIntentClientSecret: clientSecret,
        applePay: { merchantCountryCode: 'SK' },
        googlePay: { merchantCountryCode: 'SK', testEnv: __DEV__ },
        returnURL: 'blup://stripe-redirect',
        allowsDelayedPaymentMethods: false,
      });
      if (initError) throw new Error(initError.message);

      const { error: sheetError } = await presentPaymentSheet();
      if (sheetError) {
        // A cancelled sheet is not a failure, and the unpaid campaign simply
        // never starts — there is nothing to apologise for.
        if (sheetError.code === 'Canceled') return;
        throw new Error(sheetError.message);
      }

      // The sheet succeeding only means the card was accepted. The campaign is
      // live when our server has been told so, which is what this waits for —
      // saying "kampaň beží" before that would be the frontend claiming a
      // payment it cannot see.
      const outcome = session.orderId ? await waitForBoost(session.orderId) : 'pending';
      if (outcome === 'succeeded') toast.show('Kampaň beží');
      else if (outcome === 'pending') toast.show('Platba prebieha, kampaň sa spustí o chvíľu');
      else throw new Error('Platba neprešla. Kampaň sa nespustila.');

      await refresh();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBuying(false);
    }
  };

  const buyPackage = async (code: string) => {
    if (!id) return;
    setError(null);
    setBuyingPackage(code);
    try {
      const result = await payForBoost(id, code);
      if (result.status === 'redirecting') return;
      await refresh();
      toast.show('Boost sa spustí po potvrdení platby');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBuyingPackage(null);
    }
  };

  const togglePause = async (boost: EventBoost) => {
    setError(null);
    setPausing(boost.id);
    try {
      await setAdPaused(boost.id, !boost.paused_at);
      toast.show(boost.paused_at ? 'Kampaň znovu beží' : 'Kampaň je pozastavená');
      await refresh();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setPausing(null);
    }
  };

  if (!id) return <Screen><Notice tone="danger" title="Chýba event" body="Skús to z prehľadu organizátora." /></Screen>;
  if (event.isLoading) return <Screen><LoadingState /></Screen>;

  const reportFor = (boostId: string) => report.data?.find((row) => row.id === boostId);
  const live = (boosts.data ?? []).filter((b) => new Date(b.ends_at) > new Date());
  const past = (boosts.data ?? []).filter((b) => new Date(b.ends_at) <= new Date());

  return (
    <Screen scroll>
      <Caption style={styles.eventName}>{event.data?.title}</Caption>

      {error ? <Notice tone="danger" title="Nepodarilo sa" body={error} /> : null}

      {/* Coming back from Stripe's page. Deliberately not "kampaň beží": the
          card being accepted and our server being told are two different
          events, and only the second one starts delivery. */}
      {paid ? (
        <Notice
          tone="success"
          title="Platba prešla"
          body="Kampaň sa spustí, hneď ako nám to potvrdí banka — spravidla do minúty. Stav uvidíš nižšie."
        />
      ) : null}

      {/* --- what is running right now -------------------------------------- */}
      {live.length > 0 ? (
        <>
          <SectionHeader title="Beží teraz" />
          {live.map((boost) => (
            <CampaignCard
              key={boost.id}
              boost={boost}
              report={reportFor(boost.id)}
              busy={pausing === boost.id}
              onTogglePause={() => togglePause(boost)}
            />
          ))}
        </>
      ) : null}

      {/* Said once, at the top, rather than discovered by pressing a button
          that cannot work. */}
      {!isConfigured.stripe ? (
        <Notice
          tone="warning"
          title="Platby nie sú nakonfigurované"
          body="Tento build nemá Stripe kľúč, takže reklamu sa nedá zaplatiť. Doplň ho a nahraj build znova."
        />
      ) : !isStripeModuleAvailable ? (
        <Notice
          tone="warning"
          title="Platby potrebujú development build"
          body={STRIPE_UNAVAILABLE_MESSAGE}
        />
      ) : null}

      {/* --- the quick way --------------------------------------------------- */}
      {(packages.data ?? []).length > 0 ? (
        <>
          <SectionHeader title="Rýchly boost" />
          <Caption style={styles.sectionNote}>
            Hotové balíky, keď nechceš nič nastavovať. Chceš si vybrať rozpočet
            a komu to pôjde? To je kampaň nižšie.
          </Caption>

          {(packages.data ?? []).map((pack) => {
            const packQuote = packageQuotes.data?.[pack.code];
            return (
              <Pressable
                key={pack.code}
                style={styles.package}
                disabled={Boolean(buyingPackage)}
                onPress={() => buyPackage(pack.code)}
              >
                <View style={styles.flex}>
                  <Text style={styles.packageName}>{pack.name}</Text>
                  <Text style={styles.packageMeta}>
                    {pack.impressions.toLocaleString('sk-SK')} zobrazení · {pack.placements.join(', ')}
                  </Text>
                  {packQuote?.truncated ? (
                    <Text style={styles.packageWarn}>
                      Event skončí skôr — pobeží {packQuote.effective_hours} h, cena sa nemení.
                    </Text>
                  ) : null}
                  {packQuote?.queued_after ? (
                    <Text style={styles.packageMeta}>Zaradí sa za boost, ktorý práve beží.</Text>
                  ) : null}
                </View>
                <Text style={styles.packagePrice}>
                  {buyingPackage === pack.code
                    ? '…'
                    : formatMoney(pack.price_cents, pack.currency)}
                </Text>
              </Pressable>
            );
          })}
        </>
      ) : null}

      {/* --- the builder ----------------------------------------------------- */}
      <SectionHeader title="Nová kampaň" />
      <Caption style={styles.sectionNote}>
        Rozpočet, publikum a dni si určuješ ty. Cenu počíta BLUP.
      </Caption>

      <Panel title="Rozpočet" hint="Minimálne 5 €. Účtuje sa naraz, dopredu.">
        <View style={styles.chipRow}>
          {BUDGET_PRESETS.map((cents) => (
            <Chip
              key={cents}
              label={formatMoney(cents, 'EUR')}
              selected={budgetCents === cents}
              onPress={() => setBudget(String(cents / 100))}
            />
          ))}
        </View>
        <Input
          value={budget}
          onChangeText={setBudget}
          keyboardType="decimal-pad"
          placeholder="25"
          label="Vlastná suma (€)"
        />
        {quote.data && budgetCents >= 500 ? (
          <Text style={styles.quoteLine}>
            {quote.data.impressions.toLocaleString('sk-SK')} zobrazení
            {' · '}
            {formatMoney(quote.data.cpm_cents, 'EUR')} za 1 000 zobrazení
          </Text>
        ) : (
          <Text style={styles.quoteLineMuted}>Zadaj aspoň 5 €.</Text>
        )}
      </Panel>

      <Panel title="Ako dlho" hint="Rozpočet sa rozloží na tieto dni, nie minie za hodinu.">
        <View style={styles.chipRow}>
          {DAY_PRESETS.map((value) => (
            <Chip
              key={value}
              label={`${value} dní`}
              selected={days === value}
              onPress={() => setDays(value)}
            />
          ))}
        </View>
        <Caption>
          Kampaň nikdy nebeží dlhšie ako samotný event — po ňom by to boli
          peniaze za nič, tak sa skráti.
        </Caption>
      </Panel>

      <Panel title="Kde" hint="Aspoň jedno miesto.">
        {PLACEMENTS.map((placement) => (
          <Pressable
            key={placement.value}
            onPress={() => togglePlacement(placement.value)}
            style={[
              styles.placement,
              placements.includes(placement.value) && styles.placementOn,
            ]}
          >
            <View style={styles.flex}>
              <Text style={styles.placementLabel}>{placement.label}</Text>
              <Text style={styles.placementNote}>{placement.note}</Text>
            </View>
            <Text style={styles.placementMark}>
              {placements.includes(placement.value) ? '✓' : '＋'}
            </Text>
          </Pressable>
        ))}
      </Panel>

      <Panel title="Komu" hint="Okruh od miesta konania a záujmy, ktoré si ľudia sami zvolili.">
        <View style={styles.chipRow}>
          {RADIUS_PRESETS.map((metres) => (
            <Chip
              key={metres}
              label={kilometres(metres)}
              selected={radiusM === metres}
              onPress={() => setRadiusM(metres)}
            />
          ))}
        </View>

        <Caption style={styles.categoriesHint}>
          Bez výberu ide kampaň všetkým v okruhu.
        </Caption>
        <View style={styles.chipRow}>
          {CATEGORIES.map((category) => (
            <Chip
              key={category.value}
              label={category.label}
              selected={categories.includes(category.value)}
              onPress={() => toggleCategory(category.value)}
            />
          ))}
        </View>
      </Panel>

      {/* --- the number the whole screen exists for --------------------------- */}
      <Panel style={styles.reach}>
        <Text style={styles.reachLabel}>Odhadovaný dosah</Text>
        <Text style={styles.reachValue}>
          {audience.isLoading && !audience.data
            ? '…'
            : (audience.data?.people ?? 0).toLocaleString('sk-SK')}
        </Text>
        <Text style={styles.reachUnit}>
          ľudí v okruhu {kilometres(audience.data?.radius_m ?? radiusM)}
          {categories.length > 0 ? ' s týmito záujmami' : ''}
        </Text>

        <View style={styles.reachSplit}>
          <Text style={styles.reachActive}>
            {(audience.data?.active_people ?? 0).toLocaleString('sk-SK')}
          </Text>
          <Text style={styles.reachActiveNote}>
            z nich otvorilo BLUP za posledný mesiac
          </Text>
        </View>

        {/* The honest caveat, on the screen and not in a help article. */}
        <Text style={styles.reachCaveat}>
          Dosah nie je sľub. Kto appku neotvorí, nič neuvidí, a nikomu sa tá istá
          reklama neukáže viac než 3× denne. Preto je vedľa dosahu aj počet
          aktívnych ľudí — tomu číslu je bližšie to, čo sa naozaj doručí.
        </Text>

        {audience.data && audience.data.people === 0 ? (
          <Notice
            tone="warning"
            title="Toto publikum je prázdne"
            body="V okruhu nie je nikto s týmito záujmami. Rozšír okruh alebo uber záujmy — inak kampaň minie rozpočet na nikoho."
          />
        ) : null}
      </Panel>

      <Button
        title={buying ? 'Pripravujem…' : `Spustiť kampaň za ${formatMoney(budgetCents, 'EUR')}`}
        onPress={buy}
        loading={buying}
        disabled={budgetCents < 500 || (audience.data?.people ?? 0) === 0}
        large
      />
      <Caption style={styles.payNote}>
        Kampaň sa spustí až keď platbu potvrdí banka.
      </Caption>

      {/* --- history ---------------------------------------------------------- */}
      {past.length > 0 ? (
        <>
          <SectionHeader title="Staršie kampane" />
          {past.map((boost) => (
            <CampaignCard key={boost.id} boost={boost} report={reportFor(boost.id)} readOnly />
          ))}
        </>
      ) : null}
    </Screen>
  );
}

function statusOf(boost: EventBoost): { label: string; tone: 'ok' | 'warn' | 'muted' } {
  if (boost.payment_status !== 'succeeded') return { label: 'Čaká na platbu', tone: 'warn' };
  if (boost.paused_at) return { label: 'Pozastavená', tone: 'warn' };
  if (new Date(boost.starts_at) > new Date()) return { label: 'V rade', tone: 'muted' };
  if (new Date(boost.ends_at) <= new Date()) return { label: 'Skončila', tone: 'muted' };
  return { label: 'Beží', tone: 'ok' };
}

function CampaignCard({
  boost, report, busy, onTogglePause, readOnly,
}: {
  boost: EventBoost;
  report?: {
    impressions_served: number;
    people_reached: number;
    clicks: number;
    ctr_pct: number;
    tickets_attributed: number;
  };
  busy?: boolean;
  onTogglePause?: () => void;
  readOnly?: boolean;
}) {
  const status = statusOf(boost);
  const served = report?.impressions_served ?? boost.impressions_served ?? 0;
  const pct = boost.impression_budget > 0
    ? Math.min(100, Math.round((served / boost.impression_budget) * 100))
    : 0;

  // What a ticket cost. The only number in an ad report that an organizer can
  // compare against anything, so it is not buried under impressions.
  const tickets = report?.tickets_attributed ?? 0;
  const perTicket = tickets > 0 ? Math.round(boost.amount_cents / tickets) : null;

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle}>
          {boost.is_campaign ? 'Kampaň' : (boost.package_code ?? 'Boost')}
          {' · '}
          {formatMoney(boost.amount_cents, boost.currency)}
        </Text>
        <Text style={[
          styles.cardStatus,
          status.tone === 'ok' && styles.statusOk,
          status.tone === 'warn' && styles.statusWarn,
        ]}>
          {status.label}
        </Text>
      </View>

      <Text style={styles.cardDates}>
        {formatEventDate(boost.starts_at)} – {formatEventDate(boost.ends_at)}
        {' · '}
        {boost.placements.join(', ')}
      </Text>

      {boost.target_radius_m ? (
        <Text style={styles.cardTarget}>
          {kilometres(boost.target_radius_m)}
          {boost.target_categories?.length
            ? ` · ${boost.target_categories.join(', ')}`
            : ' · všetci v okruhu'}
        </Text>
      ) : null}

      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${pct}%` }]} />
      </View>
      <Text style={styles.cardMeta}>
        {served.toLocaleString('sk-SK')} z {boost.impression_budget.toLocaleString('sk-SK')} zobrazení
      </Text>

      {report ? (
        <View style={styles.statRow}>
          <Stat label="Ľudí" value={report.people_reached.toLocaleString('sk-SK')} />
          <Stat label="Klikov" value={String(report.clicks)} />
          <Stat label="CTR" value={`${report.ctr_pct.toFixed(1)} %`} />
          <Stat label="Vstupeniek" value={String(tickets)} />
        </View>
      ) : null}

      {perTicket !== null ? (
        <Text style={styles.perTicket}>
          {formatMoney(perTicket, boost.currency)} za predanú vstupenku
        </Text>
      ) : report && served > 0 ? (
        <Text style={styles.perTicketNone}>
          Zatiaľ z tejto kampane nikto nekúpil vstupenku.
        </Text>
      ) : null}

      {!readOnly && onTogglePause && boost.payment_status === 'succeeded' ? (
        <Button
          title={boost.paused_at ? 'Spustiť znova' : 'Pozastaviť'}
          variant="secondary"
          onPress={onTogglePause}
          loading={busy}
          style={styles.pauseButton}
        />
      ) : null}

      {boost.paused_at ? (
        <Caption>Rozpočet sa nestráca — čaká, kým kampaň znovu spustíš.</Caption>
      ) : null}
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  eventName: { marginBottom: spacing.sm },
  sectionNote: { marginBottom: spacing.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.sm },
  quoteLine: {
    ...typography.caption,
    color: colors.accent,
    marginTop: spacing.xs,
  },
  quoteLineMuted: { ...typography.caption, color: colors.textQuaternary, marginTop: spacing.xs },
  categoriesHint: { marginBottom: spacing.xs },

  placement: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.xs,
  },
  placementOn: { borderColor: colors.accent, backgroundColor: 'rgba(0, 128, 255, 0.08)' },
  placementLabel: { ...typography.body, color: colors.text },
  placementNote: { ...typography.caption, color: colors.textTertiary },
  placementMark: { ...typography.body, color: colors.accent },

  reach: { alignItems: 'flex-start' },
  reachLabel: { ...typography.caption, color: colors.textTertiary },
  reachValue: { ...typography.display, color: colors.text, marginTop: spacing.xs },
  reachUnit: { ...typography.body, color: colors.textSecondary },
  reachSplit: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  reachActive: { ...typography.title, color: colors.accent },
  reachActiveNote: { ...typography.caption, color: colors.textTertiary, flex: 1 },
  reachCaveat: {
    ...typography.caption,
    color: colors.textTertiary,
    marginTop: spacing.sm,
    lineHeight: 18,
  },

  payNote: { marginTop: spacing.xs, marginBottom: spacing.lg },

  package: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.xs,
  },
  packageName: { ...typography.body, color: colors.text },
  packageMeta: { ...typography.caption, color: colors.textTertiary },
  packageWarn: { ...typography.caption, color: colors.orange },
  packagePrice: { ...typography.body, color: colors.accent },

  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.xs,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardTitle: { ...typography.body, color: colors.text, flex: 1 },
  cardStatus: { ...typography.caption, color: colors.textTertiary },
  statusOk: { color: colors.green },
  statusWarn: { color: colors.orange },
  cardDates: { ...typography.caption, color: colors.textTertiary },
  cardTarget: { ...typography.caption, color: colors.textQuaternary },
  cardMeta: { ...typography.caption, color: colors.textTertiary },

  barTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceElevated,
    overflow: 'hidden',
    marginTop: spacing.xs,
  },
  barFill: { height: 6, borderRadius: 3, backgroundColor: colors.accent },

  statRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.xs },
  stat: { flex: 1 },
  statValue: { ...typography.body, color: colors.text },
  statLabel: { ...typography.caption, color: colors.textQuaternary },

  perTicket: { ...typography.caption, color: colors.green },
  perTicketNone: { ...typography.caption, color: colors.textQuaternary },
  pauseButton: { marginTop: spacing.xs },
});
