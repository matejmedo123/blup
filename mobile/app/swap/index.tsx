import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import {
  getSwapHome, swapSearch,
  SWAP_FAMILY_GLYPH, SWAP_FAMILY_LABEL,
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
  const [query, setQuery] = useState('');
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
          actionLabel="Predať vstupenku"
          onAction={() => router.push('/swap/sell')}
        />
      ) : (
        <>
          {/* --- kategórie ---------------------------------------------- */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.families}
          >
            {h.families.map((family) => (
              <Pressable
                key={family.key}
                style={styles.family}
                accessibilityRole="button"
                onPress={() => router.push(`/swap/family/${family.key}`)}
              >
                <Text style={styles.familyGlyph}>{SWAP_FAMILY_GLYPH[family.key]}</Text>
                <Text style={styles.familyLabel}>{SWAP_FAMILY_LABEL[family.key]}</Text>
                <Caption>
                  {family.ticket_count}{' '}
                  {plural(family.ticket_count, 'vstupenka', 'vstupenky', 'vstupeniek')}
                </Caption>
                {family.from_cents != null ? (
                  <Caption style={styles.familyPrice}>
                    od {formatMoney(family.from_cents, family.currency ?? 'EUR')}
                  </Caption>
                ) : null}
              </Pressable>
            ))}
          </ScrollView>

          <Row title="Čoskoro" body="Tieto sú za rohom" events={h.soon} layout={layout} />
          <Row title="Najviac na výber" body="Kde sa dá porovnávať" events={h.most} layout={layout} />
          {h.verified.length > 0 ? (
            <Row
              title="Overené vstupenky"
              body="Vydal ich BLUP — prevedieme ich a starý kód prestane platiť"
              events={h.verified}
              layout={layout}
            />
          ) : null}
        </>
      )}

      <View style={styles.footer}>
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
      </View>
    </Screen>
  );
}

function Row({
  title, body, events, layout,
}: {
  title: string;
  body: string;
  events: SwapEvent[];
  layout: ReturnType<typeof useLayout>;
}) {
  if (events.length === 0) return null;

  return (
    <View style={styles.row}>
      <Text style={styles.rowTitle}>{title}</Text>
      <Caption style={styles.rowBody}>{body}</Caption>

      {/* Na širokom okne mriežka, na telefóne vodorovný pás — tri zoznamy pod
          sebou v jednom stĺpci by znamenali, že k tretiemu sa nikto nedorolo. */}
      {layout.isWide ? (
        <View style={styles.grid}>
          {events.map((event) => (
            <View key={event.event_id} style={cellStyle(layout.columns)}>
              <EventCard event={event} />
            </View>
          ))}
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.strip}>
          {events.map((event) => (
            <View key={event.event_id} style={styles.stripCell}>
              <EventCard event={event} />
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function EventCard({ event }: { event: SwapEvent }) {
  return (
    <Pressable
      style={styles.card}
      accessibilityRole="button"
      onPress={() => router.push(`/swap/${event.event_id}`)}
    >
      {event.cover_image_url ? (
        <Image source={{ uri: event.cover_image_url }} style={styles.cover} contentFit="cover" />
      ) : (
        <View style={[styles.cover, styles.coverEmpty]} />
      )}
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>{event.title}</Text>
        <Caption numberOfLines={1}>
          {[formatEventDate(event.start_at), event.city].filter(Boolean).join(' · ')}
        </Caption>
        <View style={styles.numbers}>
          <Text style={styles.price}>
            {event.from_cents != null
              ? `od ${formatMoney(event.from_cents, event.currency ?? 'EUR')}`
              : '—'}
          </Text>
          <Caption>
            {event.ticket_count}{' '}
            {plural(event.ticket_count, 'vstupenka', 'vstupenky', 'vstupeniek')}
          </Caption>
        </View>
        {event.verified_count > 0 ? (
          <View style={styles.verified}>
            <Text style={styles.verifiedLabel}>✓ {event.verified_count} overených</Text>
          </View>
        ) : null}
      </View>
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

const cellStyle = (columns: number) => ({ width: columns > 1 ? `${100 / columns - 2}%` as const : '100%' as const });

const CARD_WIDTH = 220;

const styles = StyleSheet.create({
  header: {
    gap: spacing.xs, marginBottom: spacing.md,
    maxWidth: CONTENT_MAX, width: '100%', alignSelf: 'center',
  },
  brandRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', gap: spacing.sm,
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
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },

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

  footer: {
    flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md,
    maxWidth: CONTENT_MAX, width: '100%', alignSelf: 'center',
  },
  footerButton: { flex: 1 },
});
