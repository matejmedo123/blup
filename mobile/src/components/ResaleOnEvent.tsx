import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getEventResaleSummary } from '@/api/resale';
import { Button, Caption } from '@/components/ui';
import { formatMoney } from '@/lib/format';
import { colors, radius, spacing, typography } from '@/theme';
import { CONTENT_MAX } from '@/hooks/useLayout';

/**
 * Burza na stránke eventu.
 *
 * Dva stavy a oba sú užitočné:
 *
 *   Niekto predáva — ukáže sa počet, najnižšia cena a koľko z toho sú overené
 *   BLUP vstupenky. Pri vypredanom evente je toto jediná cesta dnu.
 *
 *   Nikto nepredáva — ukáže sa len cesta VON: „nemôžeš ísť? predaj ju ďalej".
 *   Človek, ktorý má vstupenku a nemôže prísť, si sám od seba neotvorí sekciu
 *   s predajom; ponúknuť mu to treba tam, kde na event pozerá.
 *
 * Keď nie je ani jedno — event je zadarmo, alebo už bol — nekreslí sa nič.
 * Prázdna sekcia „burza" pod každým eventom je len šum.
 */
export function ResaleOnEvent({
  eventId, canSell,
}: {
  eventId: string;
  /** Mám na tento event vstupenku, ktorú by som mohol ponúknuť ďalej? */
  canSell: boolean;
}) {
  const summary = useQuery({
    queryKey: ['resale', 'summary', eventId],
    queryFn: () => getEventResaleSummary(eventId),
    staleTime: 60_000,
  });

  const data = summary.data;
  const has = Boolean(data && data.listings > 0);

  if (!has && !canSell) return null;

  return (
    <View style={styles.wrap}>
      {has && data ? (
        <>
          <View style={styles.row}>
            <View style={styles.text}>
              <Text style={styles.title}>
                {data.tickets === 1
                  ? '1 vstupenka od fanúšikov'
                  : `${data.tickets} vstupeniek od fanúšikov`}
              </Text>
              <Caption>
                {data.from_cents != null
                  ? `od ${formatMoney(data.from_cents, data.currency ?? 'EUR')}`
                  : 'ceny určujú predajcovia'}
                {data.verified_count > 0
                  ? ` · ${data.verified_count} overených`
                  : ''}
              </Caption>
            </View>
            <Button
              title="Na burzu"
              onPress={() => router.push(`/resale/${eventId}`)}
              style={styles.button}
            />
          </View>

          <Caption style={styles.note}>
            Peniaze držíme, kým vstupenka nie je u kupujúceho.
          </Caption>
        </>
      ) : null}

      {canSell ? (
        <View style={[styles.row, has && styles.rowSecond]}>
          <View style={styles.text}>
            <Text style={styles.title}>Nemôžeš ísť?</Text>
            <Caption>
              Ponúkni vstupenku ďalej. Prevedieme ju a tvoj kód prestane platiť.
            </Caption>
          </View>
          <Button
            title="Predať"
            variant="secondary"
            onPress={() => router.push('/resale/sell')}
            style={styles.button}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    maxWidth: CONTENT_MAX,
    width: '100%',
    alignSelf: 'center',
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: spacing.xs,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowSecond: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    marginTop: spacing.xs,
  },
  text: { flex: 1 },
  title: { ...typography.bodyStrong, color: colors.text },
  button: { minWidth: 120 },
  note: { color: colors.textTertiary },
});
