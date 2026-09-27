import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';

import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * „Čo sa tu dá robiť" — pri prvom otvorení BLUPu.
 *
 * Appka robí štyri dosť odlišné veci a prvá obrazovka ukazuje z nich jednu.
 * Bez úvodu si človek myslí, že BLUP je mapa eventov, a o vstupenkách, burze
 * ani komunitách sa nedozvie — jednoducho tam nikdy neklikne.
 *
 * Preto sú to KROKY a nie zoznam odrážok. Zoznam ôsmich vecí sa neprečíta;
 * štyri obrazovky, každá s jednou vetou a obrázkom, áno. Obrázky sú kreslené
 * z obyčajných `View`, nie z priložených súborov — nemajú čo sťahovať, škálujú
 * sa a v tmavej téme vyzerajú rovnako ako zvyšok appky.
 *
 * Ukáže sa RAZ. Kľúč v úložisku má v sebe verziu, takže keď do appky pribudne
 * niečo veľké, dá sa ukázať znova bez toho, aby sa hádalo, či to už niekto
 * videl. Zavrieť sa dá kedykoľvek a klik mimo karty ju zavrie tiež —
 * povinné čítanie by bolo horšie než žiadne.
 */
const SEEN_KEY = 'blup.welcome.v1.seen';

export function useWelcomeIntro() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const seen = await AsyncStorage.getItem(SEEN_KEY);
        if (!cancelled && !seen) setVisible(true);
      } catch {
        // Úložisko, ktoré nespolupracuje, nesmie zablokovať vstup do appky.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const dismiss = async () => {
    setVisible(false);
    try {
      await AsyncStorage.setItem(SEEN_KEY, '1');
    } catch {
      // Viď vyššie. Horší prípad je, že sa úvod ukáže znova.
    }
  };

  return { visible, open: () => setVisible(true), dismiss };
}

interface Step {
  key: string;
  tint: string;
  soft: string;
  eyebrow: string;
  title: string;
  body: string;
  art: React.ReactNode;
}

export function WelcomeIntro({
  visible, onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { isGuest } = useAuth();
  const [step, setStep] = useState(0);

  // Pri každom otvorení sa začína od začiatku. Keby si karta pamätala, kde
  // človek minule skončil, „otvor znova" by mu ukázalo poslednú obrazovku.
  useEffect(() => { if (visible) setStep(0); }, [visible]);

  const steps: Step[] = useMemo(() => [
    {
      key: 'map',
      tint: colors.accent,
      soft: colors.accentSoft,
      eyebrow: 'Domov',
      title: 'Čo sa deje okolo teba',
      body: 'Mapa a zoznam eventov v tvojom okolí — dnes, cez víkend, zadarmo aj za peniaze. Nemusíš vedieť, čo hľadáš.',
      art: <MapArt />,
    },
    {
      key: 'discover',
      tint: colors.pink,
      soft: colors.pinkSoft,
      eyebrow: 'Objav',
      title: 'Blupni si program',
      body: 'Ťahaj doprava, čo sa ti páči, a doľava, čo nie. Appka sa to učí a ďalšie návrhy sedia lepšie.',
      art: <SwipeArt />,
    },
    {
      key: 'tickets',
      tint: colors.green,
      soft: colors.successSoft,
      eyebrow: 'Vstupenky a SWAP',
      title: 'Kúp si vstupenku — alebo ju predaj ďalej',
      body: 'Vstupenka je v appke aj v e-maile a pri dverách stačí QR kód. Keď nakoniec nemôžeš ísť, ponúkneš ju na SWAPe za svoju cenu.',
      art: <TicketArt />,
    },
    {
      key: 'people',
      tint: colors.purple,
      soft: 'rgba(168, 85, 247, 0.16)',
      eyebrow: 'Ľudia, chat, príbehy',
      title: 'Sociálna sieť postavená okolo eventov',
      body: 'Spoznávaj ľudí, ktorí chodia na to isté čo ty, píš si s nimi a pridávaj príbehy priamo z miesta. Feed a komunity držia pokope to, čo sa naozaj deje — nie to, čo sa deje na internete.',
      art: <PeopleArt />,
    },
  ], []);

  const last = step === steps.length - 1;
  const current = steps[step];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(event) => event.stopPropagation()}>
          {/* Koľko toho ešte je. Bez toho človek nevie, či klikaním niečo
              otvára alebo sa zacyklil. */}
          <View style={styles.rail}>
            {steps.map((s, index) => (
              <Pressable
                key={s.key}
                onPress={() => setStep(index)}
                accessibilityRole="button"
                accessibilityLabel={`Krok ${index + 1}: ${s.title}`}
                style={styles.railHit}
              >
                <View style={[
                  styles.railSeg,
                  index <= step && { backgroundColor: current.tint },
                ]} />
              </Pressable>
            ))}
          </View>

          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
          >
            <View style={[styles.stage, { backgroundColor: current.soft, borderColor: current.tint }]}>
              {current.art}
            </View>

            <Text style={[styles.eyebrow, { color: current.tint }]}>
              {current.eyebrow.toUpperCase()}
            </Text>
            <Text style={styles.title}>{current.title}</Text>
            <Text style={styles.body}>{current.body}</Text>
          </ScrollView>

          <View style={styles.actions}>
            {last ? (
              <>
                <Button
                  title={isGuest ? 'Vytvoriť účet' : 'Poďme na to'}
                  onPress={() => {
                    onClose();
                    if (isGuest) router.push('/(auth)/sign-up');
                  }}
                />
                {/* Účet netreba na to, aby sa človek pozrel. Povedať mu to je
                    lepšie než ho o to pripraviť. */}
                <Button
                  title={isGuest ? 'Najprv sa len pozriem' : 'Zavrieť'}
                  variant="ghost"
                  onPress={onClose}
                />
              </>
            ) : (
              <>
                <Button title="Ďalej" onPress={() => setStep((v) => v + 1)} />
                <Button title="Preskočiť" variant="ghost" onPress={onClose} />
              </>
            )}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/* ===========================================================================
   Obrázky
   ---------------------------------------------------------------------------
   Kreslené z `View` a `Text`, nie z priložených súborov. Dôvod je praktický:
   štyri obrázky v rozlíšení pre telefón aj desktop sú stovky kilobajtov, ktoré
   sa sťahujú pri prvom otvorení appky — teda presne vtedy, keď na človeka
   čaká úvod a on čaká na appku.
   =========================================================================== */

/** Mapa: podklad, cesty a špendlíky. Jeden je vybraný a má bublinu. */
function MapArt() {
  return (
    <View style={styles.art}>
      <View style={styles.mapPlane}>
        <View style={[styles.mapRoad, { top: 46, left: -20, right: -20 }]} />
        <View style={[styles.mapRoad, { top: 96, left: -20, right: -20, opacity: 0.5 }]} />
        <View style={[styles.mapRoadV, { left: 74, top: -20, bottom: -20 }]} />
        <View style={[styles.mapRoadV, { left: 188, top: -20, bottom: -20, opacity: 0.5 }]} />

        <View style={[styles.pinSmall, { left: 40, top: 26 }]} />
        <View style={[styles.pinSmall, { left: 206, top: 62 }]} />
        <View style={[styles.pinSmall, { left: 96, top: 108 }]} />

        <View style={[styles.pinBig, { left: 132, top: 48 }]}>
          <Text style={styles.pinGlyph}>◉</Text>
        </View>
        <View style={[styles.bubble, { left: 96, top: 12 }]}>
          <Text style={styles.bubbleText}>Dnes · 3 km</Text>
        </View>
      </View>
    </View>
  );
}

/**
 * Objav: kôpka kariet, vrchná odklonená doprava, a po stranách to, čo ťah
 * znamená. Bez tých dvoch značiek to bol len nakrivo položený obdĺžnik.
 */
function SwipeArt() {
  return (
    <View style={styles.art}>
      <View style={[styles.swipeMark, styles.swipeNo]}>
        <Text style={styles.swipeNoText}>✕</Text>
      </View>

      <View style={[styles.deckCard, styles.deckBack]} />
      <View style={[styles.deckCard, styles.deckFront]}>
        <View style={styles.deckPhoto} />
        <View style={styles.deckLine} />
        <View style={[styles.deckLine, styles.deckLineShort]} />
      </View>
      <View style={styles.deckStamp}>
        <Text style={styles.deckStampText}>BLUP</Text>
      </View>

      <View style={[styles.swipeMark, styles.swipeYes]}>
        <Text style={styles.swipeYesText}>♥</Text>
      </View>
    </View>
  );
}

/** Vstupenka: ústrižok s výrezmi, perforáciou a QR kódom. */
function TicketArt() {
  /**
   * Kód je 7×7 s tromi hľadáčikmi v rohoch — presne tak, ako vyzerá skutočný
   * QR. Nie je to estetika: prvý pokus bol náhodná mriežka 4×4 a vyšiel z nej
   * tvar, ktorý sa nápadne podobal na hákový kríž. Symetrická mriežka bez
   * pevnej štruktúry vie vyrobiť čokoľvek, takže tu je štruktúra pevná a
   * rohové štvorce nedovolia, aby sa stred prečítal ako niečo iné.
   */
  const cells = [
    1, 1, 1, 0, 1, 1, 1,
    1, 0, 1, 0, 1, 0, 1,
    1, 1, 1, 0, 1, 1, 1,
    0, 0, 0, 1, 0, 1, 0,
    1, 1, 1, 0, 1, 1, 0,
    1, 0, 1, 1, 0, 0, 1,
    1, 1, 1, 0, 1, 0, 1,
  ];
  return (
    <View style={styles.art}>
      <View style={styles.ticket}>
        <View style={styles.ticketMain}>
          <View style={styles.ticketLine} />
          <View style={[styles.ticketLine, styles.ticketLineShort]} />
          <View style={styles.ticketPrice}>
            <Text style={styles.ticketPriceText}>19,00 €</Text>
          </View>
        </View>

        <View style={styles.ticketPerf}>
          {Array.from({ length: 7 }).map((_, i) => (
            <View key={i} style={styles.ticketDot} />
          ))}
        </View>

        <View style={styles.ticketStub}>
          <View style={styles.qr}>
            {cells.map((on, i) => (
              <View key={i} style={[styles.qrCell, on ? styles.qrOn : null]} />
            ))}
          </View>
        </View>

        <View style={[styles.ticketNotch, { left: -8 }]} />
        <View style={[styles.ticketNotch, { right: -8 }]} />
      </View>

      <View style={styles.swapTag}>
        <Text style={styles.swapTagText}>⇄ SWAP</Text>
      </View>
    </View>
  );
}

/** Ľudia: tri avatary vedľa seba a okolo nich bubliny správ. */
function PeopleArt() {
  const faces: { initials: string; color: string }[] = [
    { initials: 'EH', color: colors.cyan },
    { initials: 'MB', color: colors.pink },
    { initials: 'JK', color: colors.purple },
  ];
  return (
    <View style={styles.art}>
      <View style={styles.faces}>
        {faces.map((f, i) => (
          <View
            key={f.initials}
            style={[
              styles.face,
              { backgroundColor: f.color, marginLeft: i === 0 ? 0 : -14, zIndex: 3 - i },
            ]}
          >
            <Text style={styles.faceText}>{f.initials}</Text>
          </View>
        ))}
        {/* Krúžok príbehu — to isté, čo appka kreslí okolo avatara. */}
        <View style={styles.storyRing} />
      </View>

      <View style={styles.chatBubble}>
        <Text style={styles.chatText}>ideš zajtra?</Text>
      </View>
      <View style={styles.chatBubbleMine}>
        <Text style={styles.chatTextMine}>mám lístok ✓</Text>
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
    maxWidth: 440,
    maxHeight: '90%',
    borderRadius: radius.block,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundElevated,
    overflow: 'hidden',
  },

  rail: { flexDirection: 'row', gap: 4, padding: spacing.md, paddingBottom: 0 },
  railHit: { flex: 1, paddingVertical: 6 },
  railSeg: { height: 3, borderRadius: 2, backgroundColor: colors.surfaceElevated2 },

  scroll: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.xs },

  stage: {
    height: 180,
    borderRadius: radius.card,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: spacing.md,
  },
  art: { flex: 1 },

  eyebrow: { ...typography.metaSm, letterSpacing: 1.2, fontWeight: '700' },
  title: { ...typography.heading, color: colors.text },
  body: { ...typography.body, color: colors.textSecondary, lineHeight: 21 },

  actions: {
    padding: spacing.lg,
    paddingTop: spacing.sm,
    gap: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },

  // --- mapa ------------------------------------------------------------------
  mapPlane: { flex: 1, backgroundColor: colors.map },
  mapRoad: {
    position: 'absolute', height: 2,
    backgroundColor: colors.border, opacity: 0.8,
  },
  mapRoadV: {
    position: 'absolute', width: 2,
    backgroundColor: colors.border, opacity: 0.8,
  },
  pinSmall: {
    position: 'absolute', width: 10, height: 10, borderRadius: 5,
    backgroundColor: colors.accent, opacity: 0.45,
  },
  pinBig: {
    position: 'absolute', width: 34, height: 34, borderRadius: 17,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.accent,
    borderWidth: 3, borderColor: colors.background,
  },
  pinGlyph: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  bubble: {
    position: 'absolute',
    paddingHorizontal: spacing.sm, paddingVertical: 4,
    borderRadius: radius.chip,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
  },
  bubbleText: { ...typography.metaSm, color: colors.text },

  // --- objav -----------------------------------------------------------------
  swipeMark: {
    position: 'absolute', top: 66, width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1,
  },
  swipeNo: {
    left: 18,
    backgroundColor: colors.surfaceElevated, borderColor: colors.border,
  },
  swipeNoText: { color: colors.textTertiary, fontSize: 15, fontWeight: '700' },
  swipeYes: {
    right: 18,
    backgroundColor: colors.pinkSoft, borderColor: colors.pink,
  },
  swipeYesText: { color: colors.pink, fontSize: 15, fontWeight: '700' },

  deckCard: {
    position: 'absolute',
    left: 88, top: 18, width: 148, height: 144,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.sm, gap: 6,
  },
  deckBack: { transform: [{ rotate: '-7deg' }], opacity: 0.55 },
  deckFront: { transform: [{ rotate: '6deg' }] },
  deckPhoto: {
    height: 78, borderRadius: radius.sm,
    backgroundColor: colors.surfaceElevated2,
  },
  deckLine: { height: 7, borderRadius: 4, backgroundColor: colors.surfaceElevated2 },
  deckLineShort: { width: '55%' },
  deckStamp: {
    position: 'absolute', right: 58, top: 30,
    paddingHorizontal: spacing.sm, paddingVertical: 5,
    borderRadius: radius.chip,
    borderWidth: 2, borderColor: colors.pink,
    backgroundColor: colors.pinkSoft,
    transform: [{ rotate: '-14deg' }],
  },
  deckStampText: { ...typography.monoSm, color: colors.pink, fontWeight: '700' },

  // --- vstupenka -------------------------------------------------------------
  ticket: {
    position: 'absolute', left: 30, right: 30, top: 34,
    flexDirection: 'row',
    height: 96,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
  },
  ticketMain: { flex: 1, padding: spacing.sm, gap: 7, justifyContent: 'center' },
  ticketLine: { height: 8, borderRadius: 4, backgroundColor: colors.surfaceElevated2, width: '80%' },
  ticketLineShort: { width: '45%' },
  ticketPrice: {
    alignSelf: 'flex-start', marginTop: 2,
    paddingHorizontal: spacing.sm, paddingVertical: 3,
    borderRadius: radius.chip, backgroundColor: colors.successSoft,
  },
  ticketPriceText: { ...typography.metaSm, color: colors.green, fontWeight: '700' },
  ticketPerf: { width: 1, justifyContent: 'space-evenly', alignItems: 'center' },
  ticketDot: { width: 2, height: 5, borderRadius: 1, backgroundColor: colors.border },
  ticketStub: { width: 86, alignItems: 'center', justifyContent: 'center' },
  ticketNotch: {
    position: 'absolute', top: 38, width: 16, height: 16, borderRadius: 8,
    backgroundColor: colors.backgroundElevated,
  },
  qr: {
    width: 56, height: 56,
    flexDirection: 'row', flexWrap: 'wrap',
    borderRadius: 3, overflow: 'hidden',
  },
  qrCell: { width: 8, height: 8, backgroundColor: 'transparent' },
  qrOn: { backgroundColor: colors.text },
  swapTag: {
    position: 'absolute', right: 22, bottom: 16,
    paddingHorizontal: spacing.sm, paddingVertical: 4,
    borderRadius: radius.chip,
    backgroundColor: colors.accentSoft,
    borderWidth: 1, borderColor: colors.accentBorder,
  },
  swapTagText: { ...typography.metaSm, color: colors.accent, fontWeight: '700' },

  // --- ľudia -----------------------------------------------------------------
  faces: {
    position: 'absolute', left: 28, top: 30,
    flexDirection: 'row', alignItems: 'center',
  },
  face: {
    width: 46, height: 46, borderRadius: 23,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: colors.backgroundElevated,
  },
  faceText: { ...typography.metaSm, color: '#0B0F14', fontWeight: '800' },
  storyRing: {
    position: 'absolute', left: -4, top: -4, width: 54, height: 54, borderRadius: 27,
    borderWidth: 2, borderColor: colors.purple,
  },
  chatBubble: {
    position: 'absolute', left: 28, bottom: 26,
    paddingHorizontal: spacing.sm, paddingVertical: 6,
    borderRadius: radius.chip,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
  },
  chatText: { ...typography.metaSm, color: colors.textSecondary },
  chatBubbleMine: {
    position: 'absolute', right: 24, bottom: 58,
    paddingHorizontal: spacing.sm, paddingVertical: 6,
    borderRadius: radius.chip,
    backgroundColor: colors.accent,
  },
  chatTextMine: { ...typography.metaSm, color: '#FFFFFF', fontWeight: '600' },
});
