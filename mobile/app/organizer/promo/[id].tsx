import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getEvent } from '@/api/events';
import {
  createPromoCode, deletePromoCode, getEventBoosts, getPromoCodes, setPromoActive,
} from '@/api/promo';
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
      {liveBoost ? (
        <Notice
          tone="accent"
          title="Boost beží"
          body={`Do ${formatEventDate(liveBoost.ends_at)}. Event má vo výbere navyše ${(liveBoost.weight * 100).toFixed(0)} bodov a v zozname je označený ako sponzorovaný.`}
        />
      ) : (
        <Notice
          tone="warning"
          title="Boost sa objednáva mimo appky"
          body="Platené zviditeľnenie je pripravené v databáze (event_boosts) aj v odporúčacom algoritme, ale nákup cez appku ešte nie je zapojený na platobnú bránu. Zatiaľ ho vie zapnúť BLUP na požiadanie."
        />
      )}

      <Body muted style={styles.footnote}>
        Zľavu prepočítava server pri vytvorení objednávky. Poplatok BLUPu sa počíta zo sumy, ktorú
        kupujúci naozaj zaplatí — zľavu teda platíš ty, nie my z nášho podielu.
      </Body>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
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
