import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';

import type { SearchHit, SearchHitKind } from '@/api/events';
import { useLayout } from '@/hooks/useLayout';
import { formatEventDate } from '@/lib/format';
import { Caption } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Čo hľadanie našlo, okrem samotných eventov.
 *
 * Človek nehľadá „Koncert v hale" — hľadá „Don Toliver", „Bratislava" alebo
 * „O2 Arena". Tieto tri sú iné druhy vecí než event a zoznam eventov na ne
 * odpovedať nevie: pri interpretovi chce vidieť všetky jeho termíny, pri
 * meste všetko, čo sa tam deje.
 *
 * Preto sú hore, nad zoznamom, a sú zoskupené podľa druhu. Zmiešať ich medzi
 * eventy by znamenalo, že „Don Toliver" vyzerá ako ďalší event v poradí —
 * a kliknutie by viedlo inam, než človek čaká.
 */
const KIND_LABEL: Record<SearchHitKind, string> = {
  artist: 'Interpreti',
  city: 'Mestá',
  venue: 'Miesta',
  event: 'Eventy',
};

const KIND_GLYPH: Record<SearchHitKind, string> = {
  artist: '♪',
  city: '◎',
  venue: '⌂',
  event: '▣',
};

export function SearchHits({ hits }: { hits: SearchHit[] }) {
  const layout = useLayout();
  // Druhá poistka vedľa tej v API: komponenta, ktorá zhodí celú obrazovku
  // hľadania kvôli tvaru odpovede, je horšia než komponenta, ktorá nič
  // neukáže.
  const rows = Array.isArray(hits) ? hits : [];

  // Eventy sa tu nekreslia: tie má pod sebou vlastný zoznam s kartami, kde je
  // aj cena a vzdialenosť. Dvakrát to isté by bola len dlhšia obrazovka.
  const groups: SearchHitKind[] = ['artist', 'city', 'venue'];
  const present = groups.filter((kind) => rows.some((hit) => hit.kind === kind));

  if (present.length === 0) return null;

  return (
    <View style={styles.wrap}>
      {present.map((kind) => {
        const group = rows.filter((hit) => hit.kind === kind);
        return (
          <View key={kind} style={styles.group}>
            <Text style={styles.groupTitle}>{KIND_LABEL[kind]}</Text>

            {/* Na širokom okne sa zmestia vedľa seba a rolovať netreba;
                na telefóne je to vodorovný pás, aby nezabrali celú obrazovku
                skôr, než sa človek dostane k eventom. */}
            {layout.isWide ? (
              <View style={styles.grid}>
                {group.map((hit) => <HitCard key={`${hit.kind}:${hit.key}`} hit={hit} />)}
              </View>
            ) : (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.row}
                keyboardShouldPersistTaps="handled"
              >
                {group.map((hit) => <HitCard key={`${hit.kind}:${hit.key}`} hit={hit} />)}
              </ScrollView>
            )}
          </View>
        );
      })}
    </View>
  );
}

function HitCard({ hit }: { hit: SearchHit }) {
  const count = hit.event_count === 1
    ? '1 event'
    : hit.event_count < 5 ? `${hit.event_count} eventy` : `${hit.event_count} eventov`;

  return (
    <Pressable
      style={styles.card}
      accessibilityRole="button"
      onPress={() => router.push(`/browse/${hit.kind}/${encodeURIComponent(hit.key)}`)}
    >
      {hit.image_url ? (
        <Image source={{ uri: hit.image_url }} style={styles.cover} contentFit="cover" />
      ) : (
        <View style={[styles.cover, styles.coverEmpty]}>
          <Text style={styles.glyph}>{KIND_GLYPH[hit.kind]}</Text>
        </View>
      )}

      <View style={styles.body}>
        <Text style={styles.label} numberOfLines={1}>{hit.label}</Text>
        <Caption numberOfLines={1}>
          {hit.sublabel ? `${hit.sublabel} · ${count}` : count}
        </Caption>
        {hit.next_at ? (
          <Caption numberOfLines={1} style={styles.next}>
            najbližšie {formatEventDate(hit.next_at)}
          </Caption>
        ) : null}

        {/* Keď je koncert vypredaný, je SWAP jediná cesta dnu — a je to
            presne tá informácia, pre ktorú človek hľadanie otvoril. */}
        {hit.resale_count > 0 ? (
          <View style={styles.resale}>
            <Text style={styles.resaleLabel}>
              {hit.resale_count === 1
                ? '1 na SWAPe'
                : `${hit.resale_count} na SWAPe`}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const CARD_WIDTH = 190;

const styles = StyleSheet.create({
  wrap: { gap: spacing.md, marginBottom: spacing.md },
  group: { gap: spacing.xs },
  groupTitle: { ...typography.bodyStrong, color: colors.text },
  row: { gap: spacing.sm, paddingRight: spacing.lg },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },

  card: {
    width: CARD_WIDTH,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  cover: { width: '100%', height: 96, backgroundColor: colors.surfaceElevated },
  coverEmpty: { alignItems: 'center', justifyContent: 'center' },
  glyph: { fontSize: 26, color: colors.textQuaternary },

  body: { padding: spacing.sm, gap: 2 },
  label: { ...typography.bodyStrong, color: colors.text },
  next: { color: colors.textTertiary },

  resale: {
    alignSelf: 'flex-start',
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accentBorder,
  },
  resaleLabel: { ...typography.metaSm, color: colors.accent, fontWeight: '700' },
});
