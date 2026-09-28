import React, { useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import {
  getEventResaleListings, getEventResaleSections, getEventResaleSummary,
  type ResaleListing, type ResaleSort, type ResaleSource,
} from '@/api/resale';
import { getEvent } from '@/api/events';
import { AuthenticityBadge } from '@/components/AuthenticityBadge';
import {
  Avatar, Caption, EmptyState, ErrorState, Input, LoadingState, Screen,
} from '@/components/ui';
import { useLayout, CONTENT_MAX_WIDE } from '@/hooks/useLayout';
import { formatEventDate, formatMoney } from '@/lib/format';
import { colors, radius, shadow, spacing, typography } from '@/theme';
import { GradientCover } from '@/components/GradientCover';

/**
 * BLUP SWAP — ponuky na jeden event.
 *
 * Ponuky od ľudí, ktorí na event nemôžu ísť. Dve veci, na ktorých obrazovka
 * stojí:
 *
 *   Cena je vidno celá. Pri každej ponuke je to, čo pýta predajca, a pod ňou
 *   pôvodná cena, ak ju poznáme. Poplatok sa doráta v checkoute a je tam
 *   rozpísaný zvlášť — človek musí vedieť, čo naozaj zaplatí, skôr než klikne.
 *
 *   Štítok pravosti je pri každej ponuke a berie sa zo servera. „Overená" smie
 *   byť len tam, kde vstupenku vydal BLUP a vieme ju previesť; všade inde je
 *   „chránená platba", čo je poctivejšie a menej.
 */
const SORTS: { key: ResaleSort; label: string }[] = [
  { key: 'price_asc', label: 'Najlacnejšie' },
  { key: 'price_desc', label: 'Najdrahšie' },
  { key: 'newest', label: 'Najnovšie' },
];

const SOURCES: { key: ResaleSource | null; label: string }[] = [
  { key: null, label: 'Všetky' },
  { key: 'blup', label: 'Len overené' },
];

export default function EventResaleScreen() {
  /**
   * V adrese je slug (`/swap/hypeland`) alebo uuid (`/swap/863b30b0-…`).
   *
   * Obe musia fungovať: odkaz, ktorý si niekto pred mesiacom hodil do chatu,
   * nesmie prestať fungovať preto, že sa adresy stali čitateľnými. `getEvent`
   * si s oboma poradí sám; funkcie pre ponuky ale poznajú len uuid, takže sa
   * čaká, kým event dorazí, a až z neho sa berie `id`.
   */
  const { event: eventRef } = useLocalSearchParams<{ event: string }>();
  const layout = useLayout();
  const [sort, setSort] = useState<ResaleSort>('price_asc');
  const [source, setSource] = useState<ResaleSource | null>(null);
  /**
   * Sektor, rad alebo miesto.
   *
   * Na vypredanom štadióne je pod eventom tridsať ponúk a človek nehľadá „tú
   * najlacnejšiu" — chce tribúnu, na ktorej sedia jeho ľudia. Jedno pole,
   * ktoré hľadá naraz v sektore, rade, mieste aj popise vstupenky, lebo
   * kupujúci nemá ako tušiť, kam to predajca zapísal.
   */
  const [place, setPlace] = useState('');

  const event = useQuery({
    queryKey: ['event', eventRef],
    queryFn: () => getEvent(eventRef!),
    enabled: Boolean(eventRef),
  });

  const eventId = event.data?.id ?? null;

  const summary = useQuery({
    queryKey: ['resale', 'summary', eventId],
    queryFn: () => getEventResaleSummary(eventId!),
    enabled: Boolean(eventId),
  });

  const listings = useQuery({
    queryKey: ['resale', 'listings', eventId, sort, source, place],
    queryFn: () => getEventResaleListings(eventId!, { sort, source, section: place }),
    enabled: Boolean(eventId),
  });

  // Štítky sa neodvodzujú z načítaných ponúk, ale zo servera — inak by po
  // zapnutí filtra zmizli práve tie, medzi ktorými si chce človek prepínať.
  const sections = useQuery({
    queryKey: ['resale', 'sections', eventId],
    queryFn: () => getEventResaleSections(eventId!),
    enabled: Boolean(eventId),
    staleTime: 60_000,
  });

  // Aj kým sa hľadá event. Bez toho by sa na moment ukázalo „žiadne ponuky" —
  // dotaz na ponuky totiž ešte nebeží, lebo nevie, na aký event sa pýtať, a
  // vypnutý dotaz sa netvári, že načítava.
  if (event.isLoading || listings.isLoading) {
    return <Screen><LoadingState label="Načítavam ponuky…" /></Screen>;
  }
  if (event.error) {
    return (
      <Screen>
        <ErrorState
          title="Taký event sme nenašli"
          message="Odkaz je asi neúplný alebo event medzitým zmizol."
          onRetry={() => router.replace('/swap')}
          retryLabel="Späť na SWAP"
        />
      </Screen>
    );
  }
  if (listings.error) {
    return (
      <Screen>
        <ErrorState
          title="Ponuky sa nenačítali"
          message="Skús to prosím znova."
          onRetry={() => void listings.refetch()}
        />
      </Screen>
    );
  }

  const rows = listings.data ?? [];
  const stats = summary.data;

  return (
    <Screen scroll={false}>
      {/* Náhľad eventu, na ktorý sa kupuje.
          Predtým tu bol len nadpis a kupujúci nemal ako overiť, či je na
          správnom evente — meno koncertu sa dá pomýliť, plagát nie. Fotka je
          tá istá 16:9, ktorá sa nahráva k eventu, a keď chýba, kreslí sa
          gradient podľa kategórie, rovnako ako na karte v BLUPe. */}
      {event.data ? (
        <View style={styles.hero}>
          <GradientCover
            uri={event.data.cover_image_url}
            category={event.data.category}
            height={168}
            whole
            overlay
          >
            <View style={styles.heroText}>
              <Text style={styles.eventName} numberOfLines={2}>{event.data.title}</Text>
              <Text style={styles.heroMeta} numberOfLines={1}>
                {[
                  formatEventDate(event.data.start_at),
                  event.data.venue_name,
                  event.data.city,
                ].filter(Boolean).join(' · ')}
              </Text>
            </View>
          </GradientCover>
        </View>
      ) : null}

      {stats && stats.listings > 0 ? (
        <View style={styles.summary}>
          <View style={styles.summaryCell}>
            <Text style={styles.summaryBig}>{stats.tickets}</Text>
            <Caption>
              {stats.tickets === 1 ? 'vstupenka' : stats.tickets < 5 ? 'vstupenky' : 'vstupeniek'}
            </Caption>
          </View>
          <View style={styles.summaryCell}>
            <Text style={styles.summaryBig}>
              {stats.from_cents != null
                ? formatMoney(stats.from_cents, stats.currency ?? 'EUR')
                : '—'}
            </Text>
            <Caption>od</Caption>
          </View>
          <View style={styles.summaryCell}>
            <Text style={styles.summaryBig}>{stats.verified_count}</Text>
            <Caption>overených</Caption>
          </View>
        </View>
      ) : null}

      {/* --- kde chcem sedieť ------------------------------------------- */}
      <View style={styles.place}>
        <Input
          value={place}
          onChangeText={setPlace}
          placeholder="Sektor, rad alebo miesto…"
          autoCapitalize="characters"
          autoCorrect={false}
          returnKeyType="search"
        />
        {/* Štítky sú to, čo na evente NAOZAJ je — nie zoznam sektorov haly.
            Prázdne pole s nápisom „skús sektor" je rada rovnako zlá ako
            žiadna: človek nevie, či sa sektory volajú A/B/C alebo Sever/Juh,
            a po treťom prázdnom výsledku to vzdá. */}
        {(sections.data ?? []).length > 1 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.chipScroll}
            contentContainerStyle={styles.sectionRow}
          >
            <Pressable
              onPress={() => setPlace('')}
              style={[styles.chip, place === '' && styles.chipOn]}
            >
              <Text style={[styles.chipLabel, place === '' && styles.chipLabelOn]}>
                Všade
              </Text>
            </Pressable>

            {(sections.data ?? []).map((section) => {
              const on = place.trim().toLowerCase() === section.label.toLowerCase();
              return (
                <Pressable
                  key={section.label}
                  onPress={() => setPlace(on ? '' : section.label)}
                  style={[styles.chip, on && styles.chipOn]}
                  accessibilityRole="button"
                  accessibilityLabel={`${section.label}, ${section.ticket_count} vstupeniek`}
                >
                  <Text style={[styles.chipLabel, on && styles.chipLabelOn]}>
                    {section.label}
                    <Text style={styles.chipCount}>{`  ${section.ticket_count}`}</Text>
                    {section.from_cents != null
                      ? <Text style={styles.chipCount}>
                          {`  od ${formatMoney(section.from_cents, section.currency ?? 'EUR')}`}
                        </Text>
                      : null}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}
      </View>

      <View style={styles.filters}>
        {SORTS.map((option) => (
          <Pressable
            key={option.key}
            onPress={() => setSort(option.key)}
            style={[styles.chip, sort === option.key && styles.chipOn]}
          >
            <Text style={[styles.chipLabel, sort === option.key && styles.chipLabelOn]}>
              {option.label}
            </Text>
          </Pressable>
        ))}
        <View style={styles.filterGap} />
        {SOURCES.map((option) => (
          <Pressable
            key={option.label}
            onPress={() => setSource(option.key)}
            style={[styles.chip, source === option.key && styles.chipOn]}
          >
            <Text style={[styles.chipLabel, source === option.key && styles.chipLabelOn]}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Na monitore sa ponuky ukladajú do mriežky. Jeden stĺpec kariet cez
          celú šírku znamená, že na obrazovku sa zmestia tri ponuky a
          porovnávať ceny sa dá len rolovaním hore-dole — pri burze, kde je
          porovnanie celý dôvod návštevy, je to to najhoršie rozloženie. */}
      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        numColumns={layout.columns}
        key={`cols-${layout.columns}`}
        columnWrapperStyle={layout.columns > 1 ? styles.columns : undefined}
        contentContainerStyle={[
          styles.list,
          layout.isWide && { maxWidth: CONTENT_MAX_WIDE, alignSelf: 'center', width: '100%' },
        ]}
        ListEmptyComponent={
          /* Prázdno kvôli filtru a prázdno kvôli tomu, že tu nikto nepredáva,
             sú dva úplne iné stavy. Keby sa vypísal ten druhý aj po zapnutí
             filtra, človek by odišiel z eventu, na ktorom je dvadsať ponúk —
             len nie v sektore, ktorý si vybral. */
          place.trim() ? (
            <EmptyState
              emoji="🔍"
              title={`V „${place.trim()}" nič nie je`}
              body="Skús iný sektor alebo sa pozri na všetky ponuky."
              actionLabel="Ukázať všetky"
              onAction={() => setPlace('')}
            />
          ) : source ? (
            <EmptyState
              emoji="🔍"
              title="Overená vstupenka tu zatiaľ nie je"
              body="Na tento event ponúkajú len vstupenky z iných platforiem."
              actionLabel="Ukázať všetky"
              onAction={() => setSource(null)}
            />
          ) : (
            <EmptyState
              emoji="🎟"
              title="Zatiaľ tu nikto nepredáva"
              body="Keď niekto nebude môcť ísť, jeho vstupenka sa objaví tu."
            />
          )
        }
        renderItem={({ item }) => (
          <View style={layout.columns > 1 ? styles.cell : undefined}>
            <ListingRow listing={item} />
          </View>
        )}
      />
    </Screen>
  );
}

function ListingRow({ listing }: { listing: ResaleListing }) {
  const seat = [
    listing.section && `Sektor ${listing.section}`,
    listing.row_label && `rad ${listing.row_label}`,
    listing.seat_label && `miesto ${listing.seat_label}`,
  ].filter(Boolean).join(' · ');

  // Pôvodná cena sa ukáže len vtedy, keď je vyššia — inak je to buď rovnaké
  // číslo dvakrát, alebo zvýrazňovanie toho, že predajca pýta viac.
  const cheaper = listing.face_value_cents != null
    && listing.face_value_cents > listing.price_cents;

  return (
    <Pressable
      style={styles.card}
      onPress={() => router.push(`/swap/checkout/${listing.id}`)}
      accessibilityRole="button"
    >
      <View style={styles.cardTop}>
        <View style={styles.badges}>
          <AuthenticityBadge authenticity={listing.authenticity} size="s" />
          {/* Kedy ju dostanem. Dve ponuky za rovnakú cenu nie sú to isté, keď
              jedna príde v sekunde a druhá až keď sa predajca ozve — a to sa
              musí dať porovnať tu, nie až v pokladni. */}
          <Text style={listing.instant_delivery ? styles.fast : styles.slow}>
            {listing.instant_delivery ? 'hneď po zaplatení' : 'pošle predajca'}
          </Text>
        </View>
        <View style={styles.priceBlock}>
          <Text style={styles.price}>
            {formatMoney(listing.price_cents, listing.currency)}
          </Text>
          {cheaper ? (
            <Text style={styles.face}>
              {formatMoney(listing.face_value_cents!, listing.currency)}
            </Text>
          ) : null}
          {/* Toto je celá cena, nie „od". Províziu platí predajca, takže v
              pokladni nepribudne nič — a povedať to treba tu, kde sa ponuky
              porovnávajú, nie až po kliknutí. */}
          <Caption style={styles.noFees}>žiadne poplatky navyše</Caption>
        </View>
      </View>

      {seat ? <Text style={styles.seat}>{seat}</Text> : null}
      {!seat && listing.ticket_label ? (
        <Text style={styles.seat}>{listing.ticket_label}</Text>
      ) : null}

      {listing.note ? (
        <Caption numberOfLines={2} style={styles.note}>{listing.note}</Caption>
      ) : null}

      <View style={styles.cardBottom}>
        <Avatar
          url={listing.seller_avatar}
          name={listing.seller_name}
          size={24}
          userId={listing.seller_id}
        />
        <Caption numberOfLines={1} style={styles.seller}>
          {listing.seller_name ?? listing.seller_username ?? 'Predajca'}
        </Caption>
        {listing.quantity > 1 ? (
          <Caption style={styles.qty}>{listing.quantity} ks</Caption>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  badges: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexWrap: 'wrap', flex: 1 },
  fast: { ...typography.caption, color: colors.success },
  slow: { ...typography.caption, color: colors.textSecondary },
  header: {
    paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: 2,
    maxWidth: CONTENT_MAX_WIDE, alignSelf: 'center', width: '100%',
  },
  hero: {
    maxWidth: CONTENT_MAX_WIDE, width: '100%', alignSelf: 'center',
    paddingHorizontal: spacing.lg, paddingTop: spacing.xs,
    marginBottom: spacing.md,
  },
  heroText: {
    marginTop: 'auto',
    padding: spacing.md,
    gap: 2,
  },
  heroMeta: { ...typography.metaSm, color: 'rgba(255,255,255,0.86)' },
  eventName: { ...typography.subheading, color: "#FFFFFF" },

  summary: {
    flexDirection: 'row',
    marginHorizontal: spacing.lg,
    maxWidth: CONTENT_MAX_WIDE, alignSelf: 'center', width: '100%',
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  summaryCell: { flex: 1, alignItems: 'center', gap: 2 },
  summaryBig: { ...typography.subheading, color: colors.text },

  place: {
    maxWidth: CONTENT_MAX_WIDE, width: '100%', alignSelf: 'center',
    paddingHorizontal: spacing.lg, gap: spacing.xs,
  },
  // Vodorovný pás si bez `flexGrow: 0` vypýta všetko zvislé miesto.
  chipScroll: { flexGrow: 0, flexShrink: 0, alignSelf: 'stretch' },
  sectionRow: { flexDirection: 'row', gap: spacing.xs, paddingBottom: spacing.xs },
  chipCount: { color: colors.textTertiary },
  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    maxWidth: CONTENT_MAX_WIDE, alignSelf: 'center', width: '100%',
    paddingBottom: spacing.md,
    alignItems: 'center',
  },
  filterGap: { width: spacing.sm },
  chip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipLabel: { ...typography.metaSm, color: colors.textSecondary },
  chipLabelOn: { color: '#FFFFFF', fontWeight: '700' },

  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  columns: { gap: spacing.sm },
  cell: { flex: 1 },

  card: {
    padding: spacing.md,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
    ...shadow.cta,
  },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  priceBlock: { alignItems: 'flex-end' },
  price: { ...typography.subheading, color: colors.text },
  face: {
    ...typography.metaSm,
    color: colors.textQuaternary,
    textDecorationLine: 'line-through',
  },
  noFees: { fontSize: 11, color: colors.success },
  seat: { ...typography.body, color: colors.text },
  note: { color: colors.textTertiary },
  cardBottom: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  seller: { flex: 1 },
  qty: { color: colors.textSecondary },
});
