import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { swapSearch, type SwapHit, type SwapHitKind } from '@/api/swap';
import { SWAP_BRAND, SWAP_TAGLINE } from '@/swap/brand';
import {
  Button, Caption, EmptyState, Input, LoadingState, Screen,
} from '@/components/ui';
import { useLayout, CONTENT_MAX } from '@/hooks/useLayout';
import { formatEventDate, formatMoney } from '@/lib/format';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Domov BLUP SWAPu.
 *
 * Vlastný vstup do vlastného produktu — nie záložka v hľadaní BLUPu. Rozdiel
 * je v tom, čo obrazovka ukazuje, keď je pole prázdne: BLUP by ukázal, čo sa
 * deje okolo, SWAP ukáže, čo sa práve dá kúpiť. Event bez ponuky sem nepatrí,
 * lebo by viedol na prázdnu obrazovku.
 *
 * Preto je aj poradie iné: najprv to, kde je najviac ponúk a kde sú overené
 * vstupenky. Kto sem prišiel, nehľadá zážitok — hľadá vstupenku.
 */
const KIND_LABEL: Record<SwapHitKind, string> = {
  artist: 'Interpret',
  city: 'Mesto',
  venue: 'Miesto',
  event: 'Event',
};

export default function SwapHomeScreen() {
  const [query, setQuery] = useState('');
  const layout = useLayout();

  const hits = useQuery({
    queryKey: ['swap', 'search', query],
    queryFn: () => swapSearch(query, 30),
    // Aj prázdny dotaz: prvé otvorenie má ukázať, čo je v ponuke, nie prázdno
    // s výzvou „napíš niečo".
    staleTime: 30_000,
  });

  const rows = hits.data ?? [];

  return (
    <Screen scroll={false}>
      <View style={styles.header}>
        <Text style={styles.brand}>{SWAP_BRAND}</Text>
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
      </View>

      {hits.isLoading ? (
        <LoadingState label="Pozerám, čo je v ponuke…" />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => `${item.kind}:${item.key}`}
          numColumns={layout.columns}
          key={`cols-${layout.columns}`}
          columnWrapperStyle={layout.columns > 1 ? styles.columns : undefined}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            query.trim() ? (
              <EmptyState
                emoji="🔍"
                title="Na toto nikto nič neponúka"
                body="Skús iné meno alebo mesto — alebo sa pozri neskôr, ponuky pribúdajú."
              />
            ) : (
              <EmptyState
                emoji="🎟"
                title="Zatiaľ tu nikto nepredáva"
                body="Keď niekto nebude môcť ísť, jeho vstupenka sa objaví tu."
                actionLabel="Predať vstupenku"
                onAction={() => router.push('/swap/sell')}
              />
            )
          }
          renderItem={({ item }) => (
            <View style={layout.columns > 1 ? styles.cell : undefined}>
              <SwapCard hit={item} />
            </View>
          )}
        />
      )}

      <View style={styles.footer}>
        <Button
          title="Predať vstupenku"
          variant="secondary"
          onPress={() => router.push('/swap/sell')}
          style={styles.footerButton}
        />
        <Button
          title="Moje ponuky"
          variant="secondary"
          onPress={() => router.push('/swap/selling')}
          style={styles.footerButton}
        />
      </View>
    </Screen>
  );
}

function SwapCard({ hit }: { hit: SwapHit }) {
  // Event vedie rovno na jeho ponuky; interpret, mesto a miesto na zoznam
  // eventov, ktoré pod ne patria.
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
        <Caption style={styles.kind}>{KIND_LABEL[hit.kind]}</Caption>
        <Text style={styles.label} numberOfLines={1}>{hit.label}</Text>
        {hit.sublabel ? <Caption numberOfLines={1}>{hit.sublabel}</Caption> : null}
        {hit.kind === 'event' && hit.start_at ? (
          <Caption>{formatEventDate(hit.start_at)}</Caption>
        ) : null}

        <View style={styles.numbers}>
          <Text style={styles.price}>
            {hit.from_cents != null
              ? `od ${formatMoney(hit.from_cents, hit.currency ?? 'EUR')}`
              : '—'}
          </Text>
          <Caption>
            {hit.ticket_count === 1
              ? '1 vstupenka'
              : `${hit.ticket_count} vstupeniek`}
          </Caption>
        </View>

        {/* Overené sa počíta len pri vstupenkách vydaných BLUPom — tie vieme
            previesť a starý QR zabiť. Pri ostatných by to bola lož. */}
        {hit.verified_count > 0 ? (
          <View style={styles.verified}>
            <Text style={styles.verifiedLabel}>
              ✓ {hit.verified_count} {hit.verified_count === 1 ? 'overená' : 'overených'}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.xs,
    maxWidth: CONTENT_MAX, width: '100%', alignSelf: 'center',
  },
  brand: { ...typography.heading, color: colors.text, letterSpacing: 0.5 },
  tagline: { lineHeight: 18 },
  inputWrap: { marginTop: spacing.xs },
  input: { marginBottom: 0 },

  list: {
    paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm,
    maxWidth: CONTENT_MAX, width: '100%', alignSelf: 'center',
  },
  columns: { gap: spacing.sm },
  cell: { flex: 1 },

  card: {
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  cover: { width: '100%', height: 120, backgroundColor: colors.surfaceElevated },
  coverEmpty: {},
  body: { padding: spacing.md, gap: 2 },
  kind: { textTransform: 'uppercase', letterSpacing: 0.6 },
  label: { ...typography.bodyStrong, color: colors.text },

  numbers: {
    flexDirection: 'row', alignItems: 'baseline',
    gap: spacing.sm, marginTop: spacing.xs,
  },
  price: { ...typography.subheading, color: colors.text },

  verified: {
    alignSelf: 'flex-start',
    marginTop: spacing.xs,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(34, 197, 94, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(34, 197, 94, 0.45)',
  },
  verifiedLabel: { ...typography.metaSm, color: '#22C55E', fontWeight: '700' },

  footer: {
    flexDirection: 'row', gap: spacing.sm,
    paddingHorizontal: spacing.lg, paddingBottom: spacing.md,
    maxWidth: CONTENT_MAX, width: '100%', alignSelf: 'center',
  },
  footerButton: { flex: 1 },
});
