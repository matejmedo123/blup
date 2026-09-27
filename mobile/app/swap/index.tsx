import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import {
  getSwapHome, swapEvents, swapSearch,
  SWAP_FAMILY_LABEL,
  type SwapEvent, type SwapFamily, type SwapHit, type SwapHitKind,
} from '@/api/swap';
import { SWAP_BRAND, SWAP_TAGLINE } from '@/swap/brand';
import { SwapIntro, useSwapIntro } from '@/swap/SwapIntro';
import {
  Button, Caption, EmptyState, Input, LoadingState, Screen,
} from '@/components/ui';
import { useLayout, CONTENT_MAX } from '@/hooks/useLayout';
import { formatEventDate, formatMoney } from '@/lib/format';
import { colors, radius, spacing, typography } from '@/theme';
import { useAuth } from '@/auth/AuthProvider';
import { SwapEventCard } from '@/swap/SwapEventCard';

/**
 * Domov BLUP SWAPu.
 *
 * Dve obrazovky v jednej a prepína medzi nimi to, či je niečo napísané v poli:
 *
 *   prázdne pole  ponuka rozdelená do kategórií a troch zoznamov — presne to,
 *                 čo človek potrebuje, keď ešte nevie, čo hľadá
 *   text          výsledky hľadania
 *
 * Plochý zoznam všetkého bol prvý pokus a bol zlý: burza s troma ponukami
 * vyzerá rovnako ako burza s tristo, a človek, ktorý nemá konkrétne meno,
 * nemá sa čoho chytiť.
 *
 * Tri zoznamy, nie desať, a každý odpovedá na inú otázku:
 *
 *   Čoskoro    najnaliehavejšie pre obe strany — vstupenka na zajtra
 *   Najviac    kde je z čoho vyberať a kde sa dá porovnávať
 *   Overené    pre toho, kto nechce riskovať nič
 */
export default function SwapHomeScreen() {
  /**
   * Do SWAPu sa dá vojsť bez účtu a vidieť celú ponuku — to je celý zmysel
   * burzy pri vypredanom evente. Účet sa pýta až pri tom, čo sa bez neho
   * spraviť nedá, takže neprihlásenému sa neponúka „Môj SWAP": nie je čí.
   */
  const { isGuest } = useAuth();
  const [query, setQuery] = useState('');
  // Filtre presne ako na domovskej BLUPu: kategória a „len overené". Sú to
  // dve nezávislé veci, nie jeden prepínač — človek môže chcieť overené
  // vstupenky na čokoľvek aj čokoľvek na koncert.
  const [family, setFamily] = useState<SwapFamily | null>(null);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const layout = useLayout();
  const searching = query.trim().length > 0;

  // Pri prvom vstupe sa najprv povie, čo SWAP je — nech naň človek klikol
  // odkiaľkoľvek. Sedí to tu a nie na položke v menu práve preto: ciest dnu
  // je viac a ostatné by ho hodili rovno do burzy bez slova.
  const intro = useSwapIntro();

  const home = useQuery({
    queryKey: ['swap', 'home'],
    queryFn: () => getSwapHome(8),
    enabled: !searching,
    staleTime: 60_000,
  });

  /**
   * Zoznam ponuky. Jeden, zoradený podľa dátumu — rovnako ako „Dnes okolo
   * teba" na domovskej BLUPu.
   *
   * `swap_home` zostáva, ale už len kvôli číslam v hlavičke a kategóriám do
   * filtra; eventy kreslí tento dotaz.
   */
  const list = useQuery({
    queryKey: ['swap', 'events', family, verifiedOnly],
    queryFn: () => swapEvents(family, verifiedOnly, 60),
    enabled: !searching,
    staleTime: 60_000,
  });

  const hits = useQuery({
    queryKey: ['swap', 'search', query],
    queryFn: () => swapSearch(query, 30),
    enabled: searching,
    staleTime: 30_000,
  });

  const h = home.data;

  return (
    <Screen scroll>
      <SwapIntro visible={intro.visible} onClose={() => void intro.dismiss()} />

      {/* Cesta späť do BLUPu.
          SWAP je samostatná časť a dá sa doň prísť z odkazu — vtedy niet čo
          vrátiť a človek zostal zavretý v burze. Na monitore je vľavo menu,
          takže tam je to zbytočné. */}
      {layout.isDesktop ? null : (
        <Pressable
          onPress={() => router.replace('/')}
          accessibilityRole="button"
          accessibilityLabel="Späť na BLUP"
          hitSlop={8}
          style={styles.back}
        >
          <Text style={styles.backLabel}>‹  Späť na BLUP</Text>
        </Pressable>
      )}

      <View style={styles.header}>
        <View style={styles.brandRow}>
          <Text style={styles.brand}>{SWAP_BRAND}</Text>
          {/* Vysvetlenie sa dá otvoriť kedykoľvek. Raz zavreté okno, ktoré sa
              už nedá vrátiť, je nepríjemné práve vtedy, keď si ho človek
              zavrel príliš rýchlo. */}
          <Pressable
            onPress={intro.open}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Čo je BLUP SWAP"
          >
            <Text style={styles.what}>Čo je SWAP?</Text>
          </Pressable>
        </View>
        <Caption style={styles.tagline}>{SWAP_TAGLINE}</Caption>

        <View style={styles.inputWrap}>
          <Input
            value={query}
            onChangeText={setQuery}
            placeholder="Interpret, mesto, miesto alebo event…"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={styles.input}
          />
        </View>

        {!searching && h && h.total_listings > 0 ? (
          <Caption style={styles.summary}>
            {h.total_tickets} {plural(h.total_tickets, 'vstupenka', 'vstupenky', 'vstupeniek')}
            {h.from_cents != null
              ? ` · od ${formatMoney(h.from_cents, h.currency ?? 'EUR')}`
              : ''}
          </Caption>
        ) : null}
      </View>

      {/* --- hľadanie --------------------------------------------------- */}
      {searching ? (
        hits.isLoading ? (
          <LoadingState label="Hľadám…" />
        ) : (hits.data ?? []).length === 0 ? (
          <EmptyState
            emoji="🔍"
            title="Na toto nikto nič neponúka"
            body="Skús iné meno alebo mesto — alebo sa pozri neskôr, ponuky pribúdajú."
          />
        ) : (
          <View style={[styles.grid, { gap: spacing.sm }]}>
            {(hits.data ?? []).map((hit) => (
              <View key={`${hit.kind}:${hit.key}`} style={cellStyle(layout.columns)}>
                <HitCard hit={hit} />
              </View>
            ))}
          </View>
        )
      ) : home.isLoading ? (
        <LoadingState label="Pozerám, čo je v ponuke…" />
      ) : !h || h.total_listings === 0 ? (
        <EmptyState
          emoji="🎟"
          title="Zatiaľ tu nikto nepredáva"
          body="Keď niekto nebude môcť ísť, jeho vstupenka sa objaví tu."
          actionLabel={isGuest ? 'Zaregistrovať sa a predať' : 'Predať vstupenku'}
          onAction={() => router.push(isGuest ? '/(auth)/sign-up' : '/swap/sell')}
        />
      ) : (
        <>
          {/* --- filtre ------------------------------------------------- */}
          {/* Rovnaký pás ako na domovskej BLUPu. Kategórie sa berú z toho, čo
              je naozaj v ponuke — škatuľka bez jedinej vstupenky je sľub,
              ktorý sa po kliknutí nedodrží. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}
          >
            <Chip
              label="Všetko"
              active={family === null}
              onPress={() => setFamily(null)}
            />
            {h.families.map((f) => (
              <Chip
                key={f.key}
                label={SWAP_FAMILY_LABEL[f.key]}
                count={f.ticket_count}
                active={family === f.key}
                onPress={() => setFamily(family === f.key ? null : f.key)}
              />
            ))}
            <View style={styles.chipGap} />
            <Chip
              label="✓ Len overené"
              active={verifiedOnly}
              tone="good"
              onPress={() => setVerifiedOnly((v) => !v)}
            />
          </ScrollView>

          {/* --- zoznam ------------------------------------------------- */}
          {list.isLoading ? (
            <LoadingState label="Pozerám, čo je v ponuke…" />
          ) : (list.data ?? []).length === 0 ? (
            <EmptyState
              emoji="🎟"
              title="V tomto filtri nič nie je"
              body="Skús inú kategóriu alebo vypni „Len overené“."
            />
          ) : (
            <View style={styles.grid}>
              {(list.data ?? []).map((event) => (
                <View key={event.event_id} style={cellStyle(layout.columns)}>
                  <SwapEventCard event={event} />
                </View>
              ))}
            </View>
          )}
        </>
      )}

      {/* Prečo, a nie len „prihlás sa". Človek, ktorý práve pozerá ponuku, má
          vedieť, že ju pozerať smie a načo mu účet bude. */}
      {isGuest ? (
        <Caption style={styles.guestNote}>
          Pozerať môžeš aj bez účtu. Na kúpu a predaj ho treba — vstupenku
          musíme mať komu priradiť a peniaze komu poslať.
        </Caption>
      ) : null}

      <View style={styles.footer}>
        {isGuest ? (
          <>
            <Button
              title="Zaregistrovať sa"
              onPress={() => router.push('/(auth)/sign-up')}
              style={styles.footerButton}
            />
            <Button
              title="Už mám účet"
              variant="secondary"
              onPress={() => router.push('/(auth)/sign-in')}
              style={styles.footerButton}
            />
          </>
        ) : (
          <>
            <Button
              title="Predať vstupenku"
              onPress={() => router.push('/swap/sell')}
              style={styles.footerButton}
            />
            <Button
              title="Môj SWAP"
              variant="secondary"
              onPress={() => router.push('/swap/selling')}
              style={styles.footerButton}
            />
          </>
        )}
      </View>
    </Screen>
  );
}

/**
 * Filter. Vizuálne to isté, čo má domovská BLUPu — aby sa človek na SWAPe
 * nemusel učiť druhé ovládanie tej istej veci.
 */
function Chip({
  label, count, active, tone, onPress,
}: {
  label: string;
  count?: number;
  active: boolean;
  tone?: 'good';
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={[
        styles.chip,
        active && styles.chipActive,
        active && tone === 'good' && styles.chipActiveGood,
      ]}
    >
      <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>
        {label}
        {count != null ? <Text style={styles.chipCount}>{`  ${count}`}</Text> : null}
      </Text>
    </Pressable>
  );
}

function HitCard({ hit }: { hit: SwapHit }) {
  const KIND: Record<SwapHitKind, string> = {
    artist: 'Interpret', city: 'Mesto', venue: 'Miesto', event: 'Event',
  };
  const go = () => {
    if (hit.kind === 'event' && hit.event_id) router.push(`/swap/${hit.event_id}`);
    else router.push(`/swap/for/${hit.kind}/${encodeURIComponent(hit.key)}`);
  };

  return (
    <Pressable style={styles.card} onPress={go} accessibilityRole="button">
      {hit.image_url ? (
        <Image source={{ uri: hit.image_url }} style={styles.cover} contentFit="cover" />
      ) : (
        <View style={[styles.cover, styles.coverEmpty]} />
      )}
      <View style={styles.body}>
        <Caption style={styles.kind}>{KIND[hit.kind]}</Caption>
        <Text style={styles.name} numberOfLines={1}>{hit.label}</Text>
        {hit.sublabel ? <Caption numberOfLines={1}>{hit.sublabel}</Caption> : null}
        <View style={styles.numbers}>
          <Text style={styles.price}>
            {hit.from_cents != null
              ? `od ${formatMoney(hit.from_cents, hit.currency ?? 'EUR')}`
              : '—'}
          </Text>
          <Caption>
            {hit.ticket_count}{' '}
            {plural(hit.ticket_count, 'vstupenka', 'vstupenky', 'vstupeniek')}
          </Caption>
        </View>
      </View>
    </Pressable>
  );
}

/** Jeden, dva až štyri, päť a viac — slovenčina skloňuje inak než angličtina. */
function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  if (n >= 2 && n <= 4) return few;
  return many;
}

/**
 * Šírka jednej bunky mriežky.
 *
 * Od podielu sa odpočíta medzera, ktorú medzi sebou karty majú — inak by si
 * `gap` a `width` protirečili a posledná karta v riadku by pretiekla do
 * ďalšieho. Pri troch stĺpcoch sú medzery dve, takže sa delia tromi.
 */
const GRID_GAP = spacing.lg;
const cellStyle = (columns: number) =>
  columns > 1
    ? { width: `calc(${100 / columns}% - ${(GRID_GAP * (columns - 1)) / columns}px)` as unknown as number }
    : { width: '100%' as const };

const CARD_WIDTH = 220;

const styles = StyleSheet.create({
  header: {
    gap: spacing.xs, marginBottom: spacing.md,
    maxWidth: CONTENT_MAX, width: '100%', alignSelf: 'center',
  },
  // Odkaz patrí k nadpisu, nie k pravému okraju okna. So `space-between` sa
  // na širokom monitore odsunul o pol obrazovky ďalej a prestal vyzerať ako
  // vysvetlivka k tomu, čo je vedľa neho.
  brandRow: {
    flexDirection: 'row', alignItems: 'center',
    gap: spacing.md, flexWrap: 'wrap',
  },
  brand: { ...typography.heading, color: colors.text, letterSpacing: 0.5 },
  what: { ...typography.metaSm, color: colors.accent, textDecorationLine: 'underline' },
  tagline: { lineHeight: 18 },
  inputWrap: { marginTop: spacing.xs },
  input: { marginBottom: 0 },
  summary: { color: colors.textSecondary },

  families: { gap: spacing.sm, paddingBottom: spacing.md, paddingRight: spacing.lg },
  family: {
    minWidth: 140,
    padding: spacing.md,
    borderRadius: radius.card,
    borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: 2,
  },
  familyGlyph: { fontSize: 20, color: colors.accent },
  familyLabel: { ...typography.bodyStrong, color: colors.text },
  familyPrice: { color: colors.textSecondary },

  row: { marginBottom: spacing.lg, maxWidth: CONTENT_MAX, width: '100%', alignSelf: 'center' },
  rowTitle: { ...typography.subheading, color: colors.text },
  rowBody: { marginBottom: spacing.sm },
  strip: { gap: spacing.sm, paddingRight: spacing.lg },
  stripCell: { width: CARD_WIDTH },
  // Karty potrebujú vzduch. So `spacing.sm` sa na širokom okne takmer
  // dotýkali a mriežka sa čítala ako jeden blok namiesto piatich ponúk.
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },

  card: {
    borderRadius: radius.card, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface, overflow: 'hidden', flex: 1,
  },
  cover: { width: '100%', height: 110, backgroundColor: colors.surfaceElevated },
  coverEmpty: {},
  body: { padding: spacing.md, gap: 2 },
  kind: { textTransform: 'uppercase', letterSpacing: 0.6 },
  name: { ...typography.bodyStrong, color: colors.text },
  numbers: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, marginTop: spacing.xs },
  price: { ...typography.subheading, color: colors.text },

  verified: {
    alignSelf: 'flex-start', marginTop: spacing.xs,
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill,
    backgroundColor: 'rgba(34, 197, 94, 0.12)',
    borderWidth: 1, borderColor: 'rgba(34, 197, 94, 0.45)',
  },
  verifiedLabel: { ...typography.metaSm, color: '#22C55E', fontWeight: '700' },

  // Tlačidlá sa držia v strede. `Button` má vlastný strop šírky (360 px), takže
  // dve vedľa seba nikdy nevyplnia široký riadok — bez `justifyContent` sa
  // zhlukli pri ľavom okraji a vyzeralo to ako nedokončený riadok mriežky.
  footer: {
    flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md,
    justifyContent: 'center', flexWrap: 'wrap',
    maxWidth: CONTENT_MAX, width: '100%', alignSelf: 'center',
  },
  footerButton: { flex: 1 },
  chipRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    alignItems: 'center',
    paddingBottom: spacing.md,
  },
  chipGap: { width: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceElevated,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipActiveGood: { backgroundColor: colors.green, borderColor: colors.green },
  chipLabel: { ...typography.metaSm, color: colors.textSecondary, fontWeight: '600' },
  chipLabelActive: { color: '#FFFFFF' },
  chipCount: { color: 'rgba(255,255,255,0.7)' },
  guestNote: { marginTop: spacing.md, textAlign: 'center' },
  back: {
    alignSelf: 'flex-start',
    maxWidth: CONTENT_MAX, width: '100%',
    paddingBottom: spacing.xs,
  },
  backLabel: { ...typography.metaSm, color: colors.accent, fontWeight: '700' },
});
