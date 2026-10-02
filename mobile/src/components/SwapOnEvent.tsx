import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import { Button, Caption } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';
import { CONTENT_MAX_WIDE } from '@/hooks/useLayout';

/**
 * Cesta na burzu zo stránky eventu — a je jednosmerná.
 *
 * Ponúka iba to, čo sem patrí: človeku, ktorý na event má vstupenku a nemôže
 * prísť, sa povie, že ju vie ponúknuť ďalej. Sám by si sekciu s predajom
 * neotvoril; ponúknuť mu to treba tam, kde na event pozerá.
 *
 * Čo tu NIE JE a zámerne:
 *
 *   NÁKUP NA BURZE. Stránka eventu je miesto, kde organizátor predáva svoje
 *   vstupenky. Vedľa jeho ceny svietila ponuka „to isté od fanúšikov od 15 €",
 *   teda konkurencia v jeho vlastnom výklade — a človeka, ktorý prišiel kúpiť
 *   lístok, to posielalo preč z nákupu. Burza je samostatný produkt a má
 *   vlastné dvere.
 *
 *   VSTUPENKA ODINAKIAĽ. Ponúkať na stránke eventu predaj lístka kúpeného inde
 *   ide proti tomu, načo burza je. Predať sa taká vstupenka stále dá — v SWAPe,
 *   kde je to vedomé rozhodnutie a kde je pri nej napísané, že pravosť overiť
 *   nevieme. Nie ako ponuka, ktorá vyskočí každému, kto si otvorí event.
 *
 * Kto na event vstupenku nemá, nevidí tu nič. Prázdna sekcia „burza" pod
 * každým eventom je len šum.
 */
export function SwapOnEvent({
  eventId, canSell,
}: {
  eventId: string;
  /** Mám na tento event vstupenku, ktorú by som mohol ponúknuť ďalej? */
  canSell: boolean;
}) {
  if (!canSell) return null;

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <View style={styles.text}>
          <Text style={styles.title}>Nemôžeš ísť?</Text>
          <Caption>
            Ponúkni vstupenku ďalej za svoju cenu. Poradíme ti, za koľko ju
            predávajú ostatní, a peniaze držíme, kým nie je u kupujúceho.
          </Caption>
        </View>
        <Button
          title="Predať"
          variant="secondary"
          inRow
          onPress={() => router.push(`/swap/sell?event=${eventId}`)}
          style={styles.button}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    maxWidth: CONTENT_MAX_WIDE,
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
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  // `minWidth` je poistka, nie ozdoba: `flex: 1` sám osebe dovolí zmrštiť sa
  // až na nulu a vtedy sa text láme po jednom písmene pod seba. So zalomením
  // riadku vyššie to pri úzkej karte znamená, že tlačidlo spadne pod text —
  // a nie že text zmizne.
  text: { flex: 1, minWidth: 180 },
  title: { ...typography.bodyStrong, color: colors.text },
  button: { minWidth: 120 },
});
