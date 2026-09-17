import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getEvent } from '@/api/events';
import {
  createPromoCode, deletePromoCode, getEventBoosts, getPromoCodes, setPromoActive,
} from '@/api/promo';
import {
  claimFreeBoost, getBoostPackages, getBoostReport, getFreeBoost,
} from '@/api/boost';
import { payForBoost } from '@/payments/checkout';
import { messageFor } from '@/lib/errors';
import { formatEventDate, formatMoney } from '@/lib/format';
import {
  Body, Button, Caption, Chip, Input, LoadingState, Mono, Notice, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Promo codes for one event.
 *
 * The organizer defines the code here; the discount itself is applied by
 * create_order() in the database, so a buyer cannot forge one and the number
 * shown at checkout is the number charged.
 */
export default function PromoCodesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();

  const [code, setCode] = useState('');
  const [kind, setKind] = useState<'percent' | 'fixed'>('percent');
  const [value, setValue] = useState('10');
  const [maxUses, setMaxUses] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const event = useQuery({
    queryKey: ['event', id],
    queryFn: () => getEvent(id!),
    enabled: Boolean(id),
  });

  const codes = useQuery({
    queryKey: ['promo-codes', id],
    queryFn: () => getPromoCodes({ eventId: id! }),
    enabled: Boolean(id),
  });

  const boosts = useQuery({
    queryKey: ['boosts', id],
    queryFn: () => getEventBoosts(id!),
    enabled: Boolean(id),
  });

  const packages = useQuery({ queryKey: ['boost-packages'], queryFn: getBoostPackages });

  const report = useQuery({
    queryKey: ['boost-report', id],
    queryFn: () => getBoostReport(id!),
    enabled: Boolean(id),
  });

  const freeBoost = useQuery({ queryKey: ['free-boost'], queryFn: getFreeBoost, retry: false });

  const [buying, setBuying] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);

  const refreshBoosts = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['boosts', id] }),
      queryClient.invalidateQueries({ queryKey: ['boost-report', id] }),
      queryClient.invalidateQueries({ queryKey: ['free-boost'] }),
    ]);
  };

  /**
   * Premium's one a week. Live immediately — there is nothing to pay.
   *
   * Not called `useFreeBoost`: a name starting with `use` is a hook to the lint
   * rule, and it reported a rules-of-hooks violation that was not there.
   */
  const claimWeeklyBoost = async () => {
    if (!id) return;
    setError(null);
    setClaiming(true);
    try {
      await claimFreeBoost(id);
      await refreshBoosts();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setClaiming(false);
    }
  };

  const buyBoost = async (packageCode: string) => {
    if (!id) return;
    setError(null);
    setBuying(packageCode);
    try {
      const result = await payForBoost(id, packageCode);
      // On the web the browser is already on its way to Stripe; the boost goes
      // live when the webhook confirms the money, not when this returns.
      if (result.status === 'redirecting') return;
      await refreshBoosts();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBuying(null);
    }
  };

  const submit = async () => {
    setError(null);

    const trimmed = code.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,24}$/.test(trimmed)) {
      setError('Kód môže mať 3–24 znakov: písmená, čísla, _ alebo -.');
      return;
    }

    const amount = Number(value.replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Zadaj hodnotu zľavy.');
      return;
    }
    if (kind === 'percent' && amount > 100) {
      setError('Percentuálna zľava môže byť najviac 100 %.');
      return;
    }

    setSaving(true);
    try {
      await createPromoCode({
        code: trimmed,
        kind,
        value: kind === 'percent' ? Math.round(amount) : Math.round(amount * 100),
        eventId: id,
        maxUses: maxUses ? Number(maxUses) : null,
      });

      setCode('');
      setMaxUses('');
      await queryClient.invalidateQueries({ queryKey: ['promo-codes', id] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (promoId: string, isActive: boolean) => {
    try {
      await setPromoActive(promoId, !isActive);
      await queryClient.invalidateQueries({ queryKey: ['promo-codes', id] });
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  const remove = async (promoId: string) => {
    try {
      await deletePromoCode(promoId);
      await queryClient.invalidateQueries({ queryKey: ['promo-codes', id] });
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  if (event.isLoading || codes.isLoading) return <Screen><LoadingState /></Screen>;

  const liveBoost = (boosts.data ?? []).find(
    (boost) => new Date(boost.starts_at) <= new Date() && new Date(boost.ends_at) > new Date(),
  );

  return (
    <Screen scroll>
      <Text style={styles.eventTitle}>{event.data?.title}</Text>
      <Mono style={styles.eventMeta}>
        {event.data ? formatEventDate(event.data.start_at) : ''}
      </Mono>

      {error ? <Notice tone="danger" title="Nepodarilo sa" body={error} /> : null}

      <SectionHeader title="Nový kód" />
      <Input
        label="Kód"
        value={code}
        onChangeText={(next) => setCode(next.toUpperCase())}
        placeholder="EARLY20"
        autoCapitalize="characters"
        autoCorrect={false}
        editable={!saving}
      />

      <View style={styles.chips}>
        <Chip label="Percentá" selected={kind === 'percent'} onPress={() => setKind('percent')} />
        <Chip label="Pevná suma" selected={kind === 'fixed'} onPress={() => setKind('fixed')} />
      </View>

      <Input
        label={kind === 'percent' ? 'Zľava v %' : 'Zľava v EUR'}
        value={value}
        onChangeText={setValue}
        keyboardType="decimal-pad"
        editable={!saving}
      />

      <Input
        label="Max. počet použití (nepovinné)"
        value={maxUses}
        onChangeText={setMaxUses}
        keyboardType="number-pad"
        placeholder="Nechaj prázdne pre neobmedzene"
        editable={!saving}
      />

      <Button title="Vytvoriť kód" onPress={submit} loading={saving} />

      <SectionHeader title={`Kódy (${(codes.data ?? []).length})`} />
      {(codes.data ?? []).length === 0 ? (
        <Body muted>Zatiaľ žiadne kódy.</Body>
      ) : (
        (codes.data ?? []).map((promo) => (
          <View key={promo.id} style={[styles.row, !promo.is_active && styles.rowInactive]}>
            <View style={styles.flex}>
              <Text style={styles.code}>{promo.code}</Text>
              <Caption>
                {promo.kind === 'percent'
                  ? `−${promo.value} %`
                  : `−${formatMoney(promo.value, 'EUR')}`}
                {' · '}
                {promo.used_count}
                {promo.max_uses ? `/${promo.max_uses}` : ''} použití
              </Caption>
            </View>

            <Pressable onPress={() => toggle(promo.id, promo.is_active)} style={styles.rowAction}>
              <Text style={styles.rowActionText}>{promo.is_active ? 'Vypnúť' : 'Zapnúť'}</Text>
            </Pressable>
            <Pressable onPress={() => remove(promo.id)} hitSlop={8}>
              <Text style={styles.remove}>✕</Text>
            </Pressable>
          </View>
        ))
      )}

      <SectionHeader title="Boost" />
      <Caption style={styles.boostIntro}>
        Boost kupuje miesto a počet zobrazení, nie hodiny. Ukáže sa len ľuďom, ktorým event sedí —
        okolie, kategória, ešte nebol. Komu nesedí, tomu sa neukáže a ty zaň neplatíš.
      </Caption>

      {freeBoost.data?.available ? (
        <Notice
          tone="accent"
          title="Máš boost zadarmo"
          body="Premium má jeden boost týždenne. Minie sa na tento event a zapne sa hneď."
          actionLabel={claiming ? 'Zapínam…' : 'Použiť zadarmo'}
          onAction={() => void claimWeeklyBoost()}
        />
      ) : freeBoost.data?.is_premium ? (
        <Caption style={styles.boostIntro}>
          Tvoj týždenný boost zadarmo si už minul. Ďalší {freeBoost.data.renews_at
            ? formatEventDate(freeBoost.data.renews_at)
            : 'budúci týždeň'}.
        </Caption>
      ) : null}

      {liveBoost ? (
        <Notice
          tone="success"
          title="Boost beží"
          body={`Do ${formatEventDate(liveBoost.ends_at)}.`}
        />
      ) : null}

      {/* What it actually delivered. An organizer deciding whether to spend
          again deserves the number that is defensible, not the one that sells
          another boost — so reach is people, and a ticket counts only when the
          same person clicked first and bought within a day. */}
      {(report.data ?? []).map((row) => (
        <View key={row.id} style={styles.reportCard}>
          <View style={styles.reportHead}>
            <Text style={styles.reportTitle}>
              {new Date(row.starts_at).toLocaleDateString('sk-SK')} — {new Date(row.ends_at).toLocaleDateString('sk-SK')}
            </Text>
            <Caption>{row.amount_cents === 0 ? 'zadarmo' : formatMoney(row.amount_cents, row.currency)}</Caption>
          </View>

          <View style={styles.reportGrid}>
            <ReportStat label="Zobrazené" value={`${row.impressions_served} / ${row.impression_budget}`} />
            <ReportStat label="Ľuďom" value={String(row.people_reached)} />
            <ReportStat label="Kliknutí" value={`${row.clicks} (${row.ctr_pct} %)`} />
            <ReportStat label="Vstupeniek" value={String(row.tickets_attributed)} />
          </View>

          {row.cost_per_click_cents !== null ? (
            <Caption>
              {formatMoney(Math.round(row.cost_per_click_cents), row.currency)} za klik
            </Caption>
          ) : null}
        </View>
      ))}

      {(packages.data ?? []).map((pkg) => (
        <View key={pkg.code} style={styles.packageRow}>
          <View style={styles.flex}>
            <Text style={styles.packageName}>{pkg.name}</Text>
            <Caption>
              {pkg.impressions.toLocaleString('sk-SK')} zobrazení ·{' '}
              {pkg.placements.map((place) => (
                place === 'feed' ? 'feed'
                  : place === 'map' ? 'mapa'
                  : 'vyskakovacia karta'
              )).join(', ')}
            </Caption>
          </View>
          <Button
            title={formatMoney(pkg.price_cents, pkg.currency)}
            variant="secondary"
            compact
            onPress={() => void buyBoost(pkg.code)}
            loading={buying === pkg.code}
            disabled={buying !== null}
          />
        </View>
      ))}

      <Body muted style={styles.footnote}>
        Zľavu prepočítava server pri vytvorení objednávky. Poplatok BLUPu sa počíta zo sumy, ktorú
        kupujúci naozaj zaplatí — zľavu teda platíš ty, nie my z nášho podielu.
      </Body>
    </Screen>
  );
}

function ReportStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.reportStat}>
      <Text style={styles.reportValue}>{value}</Text>
      <Caption>{label}</Caption>
    </View>
  );
}

const styles = StyleSheet.create({
  boostIntro: { marginBottom: spacing.md, lineHeight: 18 },
  packageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  packageName: { ...typography.bodyStrong, color: colors.text },
  reportCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  reportHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  reportTitle: { ...typography.bodyStrong, color: colors.text },
  reportGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  reportStat: { flexGrow: 1, flexBasis: 0, minWidth: 74 },
  reportValue: { ...typography.subheading, color: colors.text },
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
  eventTitle: { ...typography.heading, color: colors.text },
  eventMeta: { color: colors.textTertiary, marginBottom: spacing.md },
  chips: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  rowInactive: { opacity: 0.55 },
  code: { ...typography.monoStrong, fontSize: 15, color: colors.text, letterSpacing: 1 },
  rowAction: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
  },
  rowActionText: { ...typography.chip, color: colors.accentText },
  remove: { fontSize: 16, color: colors.textTertiary },

  footnote: { marginTop: spacing.lg, ...typography.caption },
});
