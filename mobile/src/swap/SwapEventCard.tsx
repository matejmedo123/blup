import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import { swapRef, type SwapEvent } from '@/api/swap';
import { GradientCover } from '@/components/GradientCover';
import { Caption } from '@/components/ui';
import { formatEventDate, formatMoney } from '@/lib/format';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Karta eventu na SWAPe.
 *
 * Jedna karta pre celý SWAP — domovskú, kategóriu aj výsledky za interpretom.
 * Predtým si ju každá z tých obrazoviek kreslila sama a všetky tri kreslili
 * pri chýbajúcej fotke prázdny sivý obdĺžnik, čo vyzeralo ako nenačítaná
 * stránka.
 *
 * Titulná fotka ide cez `GradientCover`, teda cez to isté, čo kreslí obal
 * eventu na domovskej BLUPu: fotku, keď je, a inak gradient podľa kategórie so
 * šrafovaním a popiskou „[ foto z eventu ]". Rovnaký event má potom rovnakú
 * farbu v BLUPe aj na SWAPe — a chýbajúca fotka vyzerá ako rozhodnutie, nie
 * ako chyba.
 *
 * Fotka je 16:9, lebo taká sa nahráva: `uploadEventCover` ju prepúšťa cez
 * orezávanie na presne 1920 × 1080 a všetko, čo ju zobrazuje, s tým tvarom
 * počíta.
 */
export function SwapEventCard({ event }: { event: SwapEvent }) {
  return (
    <Pressable
      style={styles.card}
      accessibilityRole="button"
      accessibilityLabel={`${event.title}, ${event.ticket_count} vstupeniek`}
      onPress={() => router.push(`/swap/${swapRef(event)}`)}
    >
      <GradientCover
        uri={event.cover_image_url}
        category={event.category}
        height={COVER_HEIGHT}
        whole
        showPlaceholderLabel
      />

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

/**
 * Výška obalu, keď fotka chýba.
 *
 * S fotkou sa nepoužije: `whole` dá obalu pomer SAMOTNEJ fotky, takže titulná
 * fotka — orezaná pri nahrávaní na 1920 × 1080 — vyjde presne 16:9 a nič sa
 * z nej neodreže. Presne to isté robí karta na domovskej BLUPu; karta na
 * SWAPe mala predtým pevnú výšku 132 px a na širokej karte z toho vyšiel pás
 * asi 4:1, teda orezok plagátu, ktorý si organizátor pred chvíľou naskladal
 * do rámčeka.
 */
const COVER_HEIGHT = 168;

/** 1 / 2–4 / 5+ */
function plural(n: number, one: string, few: string, many: string) {
  if (n === 1) return one;
  if (n >= 2 && n <= 4) return few;
  return many;
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.card, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface, overflow: 'hidden', flex: 1,
  },
  body: { padding: spacing.md, gap: 2 },
  name: { ...typography.bodyStrong, color: colors.text },
  numbers: {
    flexDirection: 'row', alignItems: 'baseline',
    gap: spacing.sm, marginTop: 4, flexWrap: 'wrap',
  },
  price: { ...typography.bodyStrong, color: colors.text },
  verified: {
    alignSelf: 'flex-start', marginTop: 6,
    paddingHorizontal: spacing.sm, paddingVertical: 3,
    borderRadius: radius.chip,
    backgroundColor: colors.successSoft,
    borderWidth: 1, borderColor: 'rgba(34, 197, 94, 0.45)',
  },
  verifiedLabel: { ...typography.metaSm, color: colors.green, fontWeight: '700' },
});
