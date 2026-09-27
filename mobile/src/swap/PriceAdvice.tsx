import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ResalePriceHint } from '@/api/resale';
import { formatMoney } from '@/lib/format';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Rada k cene.
 *
 * Cenu si na SWAPe určuje predajca — server mu do nej nehovorí a pôvodná cena
 * vstupenky je už len údaj pre kupujúceho. Prázdne pole s nápisom „Cena" je
 * však rada rovnako zlá ako strop: človek netuší, či pýta veľa alebo málo, tak
 * buď podstrelí, alebo ponuku nechá visieť mesiace.
 *
 * Preto sa tu ukazuje trh: koľko ľudí na ten istý event teraz ponúka, v akom
 * rozpätí, a ak sa už niečo predalo, za koľko. Z toho sa poskladajú tri návrhy
 * — rýchlo, vyvážene, maximum — pri každom rovno suma, ktorá predajcovi príde
 * po provízii. Návrh sa dá klepnutím vložiť do poľa; nič sa nevnucuje.
 *
 * Čísla počíta server (`resale_price_hint`), nie táto obrazovka. Nie je to
 * bezpečnostné opatrenie — cena je aj tak na predajcovi — ale rada, ktorá
 * stojí na cudzích ponukách, sa nemá skladať z toho, čo appka náhodou má
 * načítané.
 */
export function PriceAdvice({
  hint, cents, onPick,
}: {
  hint: ResalePriceHint;
  /** Cena, ktorú má človek práve napísanú. NaN, kým nenapísal nič. */
  cents: number;
  onPick: (cents: number) => void;
}) {
  const cur = hint.currency;
  const fee = (value: number) => value - Math.floor((value * hint.seller_fee_bps) / 10000);

  return (
    <View style={styles.wrap}>
      <Market hint={hint} />

      {hint.suggest ? (
        <>
          {/*
            Zvýraznený je ten návrh, ktorý má človek NAOZAJ napísaný v poli.
            Predtým bola „Vyvážená" zvýraznená natvrdo, takže po kliknutí na
            „Maximum" svietila ďalej tá istá a vyzeralo to, že tlačidlá
            nefungujú. (Fungovali — cenu doplnili — len to nebolo vidieť.)
            Keď si človek cenu prepíše na vlastnú, nesvieti žiadny; to je tiež
            pravda, lebo vtedy nedrží ani jeden z návrhov.
          */}
          <View style={styles.chips}>
            <Chip
              label="Rýchly predaj"
              hint="pod trhom"
              cents={hint.suggest.fast_cents}
              net={fee(hint.suggest.fast_cents)}
              currency={cur}
              accent={cents === hint.suggest.fast_cents}
              onPress={() => onPick(hint.suggest!.fast_cents)}
            />
            <Chip
              label="Vyvážená"
              hint="stred trhu"
              cents={hint.suggest.balanced_cents}
              net={fee(hint.suggest.balanced_cents)}
              currency={cur}
              accent={cents === hint.suggest.balanced_cents}
              onPress={() => onPick(hint.suggest!.balanced_cents)}
            />
            <Chip
              label="Maximum"
              hint="horná hranica"
              cents={hint.suggest.top_cents}
              net={fee(hint.suggest.top_cents)}
              currency={cur}
              accent={cents === hint.suggest.top_cents}
              onPress={() => onPick(hint.suggest!.top_cents)}
            />
          </View>

          <Verdict hint={hint} cents={cents} />
        </>
      ) : (
        <Text style={styles.body}>
          O cenách na tomto evente zatiaľ nič nevieme. Cenu si určuješ sám —
          keď tu pribudnú ďalšie ponuky, poradíme ti podľa nich.
        </Text>
      )}
    </View>
  );
}

/** Čo sa na tom evente naozaj deje. Bez toho je rada len tvrdenie. */
function Market({ hint }: { hint: ResalePriceHint }) {
  const cur = hint.currency;
  const live = hint.live;
  const sold = hint.sold;

  const lines: string[] = [];

  if (live.count > 0 && live.min_cents != null && live.max_cents != null) {
    lines.push(
      `Teraz ponúka ${live.count} ${plural(live.count, 'predajca', 'predajcovia', 'predajcov')}`
      + (live.min_cents === live.max_cents
        ? ` za ${formatMoney(live.min_cents, cur)}.`
        : ` od ${formatMoney(live.min_cents, cur)} do ${formatMoney(live.max_cents, cur)}.`),
    );
  } else {
    lines.push('Na tento event teraz nikto iný neponúka.');
  }

  if (sold.count >= 3 && sold.median_cents != null) {
    lines.push(
      `Predalo sa ${sold.count} ${plural(sold.count, 'vstupenka', 'vstupenky', 'vstupeniek')}, `
      + `najčastejšie okolo ${formatMoney(sold.median_cents, cur)}.`,
    );
  }

  if (hint.face_value_cents != null) {
    // Vstupenka zadarmo stála nula, a veta „v predpredaji stála 0,00 €" znie
    // ako chyba výpočtu, nie ako údaj.
    lines.push(hint.face_value_cents === 0
      ? 'Vstupenka bola v predpredaji zadarmo.'
      : `V predpredaji stála ${formatMoney(hint.face_value_cents, cur)}.`);
  }

  return (
    <View style={styles.market}>
      <Text style={styles.marketTitle}>Ako sa predáva</Text>
      {lines.map((line) => (
        <Text key={line} style={styles.body}>{line}</Text>
      ))}
    </View>
  );
}

/**
 * Kde sa napísaná cena nachádza voči trhu.
 *
 * Zámerne to nikdy nie je zákaz — ani pri cene desaťnásobne nad trhom. Nad
 * trhom sa predávať smie; len to treba vedieť.
 */
function Verdict({ hint, cents }: { hint: ResalePriceHint; cents: number }) {
  if (!hint.suggest || !Number.isFinite(cents) || cents <= 0) return null;

  const { fast_cents: fast, balanced_cents: balanced, top_cents: top } = hint.suggest;

  let tone: 'ok' | 'warn' = 'ok';
  let text: string;

  if (cents < hint.min_price_cents) {
    tone = 'warn';
    text = `Menej než ${formatMoney(hint.min_price_cents, hint.currency)} platobná brána nespracuje.`;
  } else if (cents < fast) {
    text = 'Pod celým trhom — predá sa takmer isto hneď, ale zarobíš menej, než by si mohol.';
  } else if (cents <= balanced) {
    text = 'Dobrá cena. Si pod stredom trhu, takže tvoja ponuka bude medzi prvými, na ktoré kupujúci kliknú.';
  } else if (cents <= top) {
    text = 'V hornej polovici trhu. Zarobíš viac, ale ráta s tým, že to potrvá dlhšie.';
  } else {
    tone = 'warn';
    text = 'Nad celým trhom. Predať sa to môže, keď sa event vypredá — dovtedy budú kupujúci klikať na lacnejšie ponuky.';
  }

  return (
    <View style={[styles.verdict, tone === 'warn' && styles.verdictWarn]}>
      <Text style={[styles.verdictText, tone === 'warn' && styles.verdictWarnText]}>{text}</Text>
    </View>
  );
}

function Chip({
  label, hint, cents, net, currency, accent, onPress,
}: {
  label: string;
  hint: string;
  cents: number;
  net: number;
  currency: string;
  accent?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${formatMoney(cents, currency)}`}
      style={[styles.chip, accent && styles.chipAccent]}
    >
      <Text style={[styles.chipLabel, accent && styles.chipLabelAccent]}>{label}</Text>
      <Text style={styles.chipPrice}>{formatMoney(cents, currency)}</Text>
      <Text style={styles.chipHint}>{hint}</Text>
      <Text style={styles.chipNet}>tebe {formatMoney(net, currency)}</Text>
    </Pressable>
  );
}

/** 1 / 2–4 / 5+ — slovenčina to rozlišuje a appka tiež. */
function plural(n: number, one: string, few: string, many: string) {
  if (n === 1) return one;
  if (n >= 2 && n <= 4) return few;
  return many;
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm, marginTop: spacing.xs },

  market: {
    padding: spacing.md,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: 3,
  },
  marketTitle: { ...typography.bodyStrong, color: colors.text, marginBottom: 2 },
  body: { ...typography.metaSm, color: colors.textSecondary, lineHeight: 18 },

  chips: { flexDirection: 'row', gap: spacing.xs },
  chip: {
    flex: 1,
    minWidth: 0,
    padding: spacing.sm,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: 1,
  },
  chipAccent: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chipLabel: { ...typography.metaSm, color: colors.textTertiary },
  chipLabelAccent: { color: colors.accent },
  chipPrice: { ...typography.bodyStrong, color: colors.text },
  chipHint: { ...typography.metaSm, color: colors.textTertiary, lineHeight: 15 },
  chipNet: { ...typography.metaSm, color: colors.textSecondary, marginTop: 2 },

  verdict: {
    padding: spacing.sm,
    borderRadius: radius.card,
    backgroundColor: colors.accentSoft,
  },
  verdictWarn: { backgroundColor: colors.warningSoft },
  verdictText: { ...typography.metaSm, color: colors.text, lineHeight: 18 },
  verdictWarnText: { color: colors.text },
});
