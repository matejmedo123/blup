import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { SWAP_BRAND } from '@/swap/brand';
import { Button, Caption } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Čo je BLUP SWAP — povedané skôr, než sa niekto pustí do kupovania.
 *
 * Ukáže sa pri PRVOM vstupe do SWAPu, nech naň človek klikol odkiaľkoľvek: z
 * menu, z domovskej obrazovky alebo zo stránky eventu. Preto to nesedí na
 * položke v menu, ale na samotnej obrazovke — inak by sa to ukázalo len
 * jednej z tých ciest a ostatné by hodili človeka rovno do burzy bez slova.
 *
 * Potom sa už neukáže; otvoriť sa dá kedykoľvek cez „Čo je SWAP?".
 *
 * Text hovorí aj to, čo NEVIEME. Sľúbiť pravosť pri vstupenke z inej
 * platformy by bolo jednoduchšie a znelo by lepšie, ale bola by to lož, na
 * ktorú by niekto doplatil.
 */
const SEEN_KEY = 'blup.swap.intro.seen';

export function useSwapIntro() {
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const seen = await AsyncStorage.getItem(SEEN_KEY);
        if (!cancelled && !seen) setVisible(true);
      } catch {
        // Úložisko, ktoré nespolupracuje, nesmie zablokovať vstup do SWAPu.
        // Horší prípad je, že sa vysvetlenie ukáže znova — nie že sa appka
        // zasekne.
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const dismiss = async () => {
    setVisible(false);
    try {
      await AsyncStorage.setItem(SEEN_KEY, '1');
    } catch {
      // Viď vyššie.
    }
  };

  return { visible, ready, open: () => setVisible(true), dismiss };
}

export function SwapIntro({
  visible, onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Zastaví preklik cez kartu na pozadie — klik do textu nemá dialóg
            zavrieť. */}
        <Pressable style={styles.card} onPress={(event) => event.stopPropagation()}>
          <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
            <View style={styles.glyphBox}>
              <Text style={styles.glyph}>⇄</Text>
            </View>

            <Text style={styles.title}>{SWAP_BRAND}</Text>
            <Text style={styles.lead}>
              Vstupenky od ľudí, ktorí na event nemôžu ísť. Nepredáva ich
              organizátor — predáva ich niekto, kto si ju kúpil pred tebou.
            </Text>

            <Point
              glyph="✓"
              tone="good"
              title="Overená BLUP vstupenka"
              body="Vydali sme ju my. Po zaplatení ju prepíšeme na teba a pôvodný QR kód prestane platiť — predajca sa s ňou dnu nedostane."
            />

            <Point
              glyph="⛨"
              tone="accent"
              title="Vstupenka z inej platformy"
              body="Je z Ticketportalu alebo odinakiaľ. Do ich databázy nevidíme, takže jej pravosť overiť NEVIEME a netvárime sa, že vieme. Držíme peniaze, kým nepotvrdíš, že funguje — ak nie, vrátime ti ich."
            />

            <Point
              glyph="€"
              title="Cena v ponuke je cena, ktorú zaplatíš"
              body="Žiadne poplatky navyše v pokladni. Desatinu z predaja si berieme od predajcu a on to vie ešte predtým, než vstupenku ponúkne."
            />

            <Point
              glyph="⏱"
              title="Peniaze držíme my"
              body="Predajca ich dostane až po evente. Kým sa neodohrá, nikto nevie, či si sa naozaj dostal dnu."
            />

            <Caption style={styles.footnote}>
              Predávať sa dá len nepoužitá vstupenka na event, ktorý ešte bude.
              Cenu si určuje predajca — pôvodná cena je pre teba informácia,
              nie strop. Pozerať môžeš bez účtu; na kúpu ho treba.
            </Caption>

            <Button title="Rozumiem, poď ďalej" onPress={onClose} style={styles.button} />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Point({
  glyph, title, body, tone,
}: {
  glyph: string;
  title: string;
  body: string;
  tone?: 'good' | 'accent';
}) {
  return (
    <View style={styles.point}>
      <View style={[
        styles.pointGlyph,
        tone === 'good' && styles.pointGood,
        tone === 'accent' && styles.pointAccent,
      ]}>
        <Text style={[
          styles.pointGlyphText,
          tone === 'good' && styles.pointGlyphGood,
          tone === 'accent' && styles.pointGlyphAccent,
        ]}>
          {glyph}
        </Text>
      </View>
      <View style={styles.pointText}>
        <Text style={styles.pointTitle}>{title}</Text>
        <Caption style={styles.pointBody}>{body}</Caption>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.overlayModal,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 460,
    maxHeight: '88%',
    borderRadius: radius.block,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundElevated,
  },
  scroll: { padding: spacing.lg, gap: spacing.md },

  glyphBox: {
    width: 48, height: 48, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  glyph: { fontSize: 24, color: '#FFFFFF', fontWeight: '700' },

  title: { ...typography.heading, color: colors.text, letterSpacing: 0.5 },
  lead: { ...typography.body, color: colors.textSecondary, lineHeight: 21 },

  point: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  pointGlyph: {
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border,
  },
  pointGood: {
    backgroundColor: 'rgba(34, 197, 94, 0.12)',
    borderColor: 'rgba(34, 197, 94, 0.45)',
  },
  pointAccent: { backgroundColor: colors.accentSoft, borderColor: colors.accentBorder },
  pointGlyphText: { fontSize: 13, color: colors.textSecondary },
  pointGlyphGood: { color: '#22C55E' },
  pointGlyphAccent: { color: colors.accent },

  pointText: { flex: 1 },
  pointTitle: { ...typography.bodyStrong, color: colors.text },
  pointBody: { lineHeight: 18 },

  footnote: { lineHeight: 18, color: colors.textTertiary },
  button: { marginTop: spacing.xs },
});
