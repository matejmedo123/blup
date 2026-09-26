import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import {
  getResaleQuote, releaseResaleReservation, reserveResaleListing,
  type ResaleQuote, type ResaleReservation,
} from '@/api/resale';
import { AuthenticityBadge, authenticityExplainer } from '@/components/AuthenticityBadge';
import { canTakePayment, payForResale, unavailableMessage } from '@/payments/checkout';
import { useStripeBridge } from '@/payments/stripe';
import { useRequireAuth } from '@/auth/useRequireAuth';
import {
  Button, Caption, Divider, ErrorState, LoadingState, Mono, Notice, Screen, Title,
} from '@/components/ui';
import { messageFor } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Checkout burzy.
 *
 * Kupujúci musí pred zaplatením vidieť všetky riadky zvlášť, nie jedno číslo.
 * To nie je zdvorilosť — je to jediný spôsob, ako si vie dve ponuky porovnať,
 * a je to presne to, čo pri predaji vstupeniek ľuďom chýba najviac.
 *
 * Čísla sa tu nepočítajú. Prídu z `quote_resale` a appka ich iba vypíše; keby
 * si súčet rátal prehliadač, dal by sa poslať iný.
 *
 * Kým je obrazovka otvorená, vstupenku drží rezervácia. Odpočet dole je len
 * informácia pre človeka — platnosť stráži server a po jej uplynutí neprejde
 * ani objednávka, ani platba, nech prehliadač ukazuje čokoľvek.
 */
export default function ResaleCheckoutScreen() {
  const { listing: listingId } = useLocalSearchParams<{ listing: string }>();
  const { requireAuth } = useRequireAuth();
  const { initPaymentSheet, presentPaymentSheet } = useStripeBridge();

  const [reservation, setReservation] = useState<ResaleReservation | null>(null);
  const [holding, setHolding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [paying, setPaying] = useState(false);

  const quote = useQuery({
    queryKey: ['resale', 'quote', listingId],
    queryFn: () => getResaleQuote(listingId!, 1),
    enabled: Boolean(listingId),
  });

  // Odpočet. Tiká raz za sekundu a keď dobehne, tlačidlo zhasne — ale to je
  // len zobrazenie toho, čo databáza aj tak vynúti.
  useEffect(() => {
    if (!reservation) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [reservation]);

  // Keď človek odíde z obrazovky, vstupenka sa vráti do predaja hneď a
  // nečaká sa na vypršanie. Cudzí kupujúci by inak zbytočne videl
  // „rezervované" ďalších pätnásť minút.
  const leaving = useRef<string | null>(null);
  leaving.current = reservation?.id ?? null;
  useEffect(() => () => {
    if (leaving.current) void releaseResaleReservation(leaving.current).catch(() => {});
  }, []);

  const secondsLeft = useMemo(() => {
    if (!reservation) return 0;
    return Math.max(0, Math.round((new Date(reservation.expires_at).getTime() - now) / 1000));
  }, [reservation, now]);

  const hold = async () => {
    if (!requireAuth('Vstupenku ti podržíme na tvoj účet.', () => {})) return;
    setError(null);
    setHolding(true);
    try {
      setReservation(await reserveResaleListing(listingId!, 1));
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setHolding(false);
    }
  };

  /**
   * Zaplatenie.
   *
   * Appka neposiela sumu — posiela id rezervácie. Cenu spočítal server pri
   * zakladaní objednávky a objednávka zostane nezaplatená, kým to nepotvrdí
   * webhook s overeným podpisom. Návrat z platobnej brány je len návrat.
   */
  const pay = async () => {
    if (!reservation) return;
    setError(null);
    setPaying(true);
    try {
      const result = await payForResale(reservation.id, {
        initPaymentSheet,
        presentPaymentSheet,
        merchantName: 'BLUP',
      });

      // Na webe prehliadač už odchádza na platobnú bránu; nechať obrazovku
      // tak, ako je, je lepšie než blysnúť výsledkom, ktorý nikto neprečíta.
      if (result.status === 'redirecting') return;
      if (result.status === 'cancelled') { setPaying(false); return; }

      // Rezervácia sa premenila na objednávku — odchod z obrazovky ju už nemá
      // čo púšťať späť do predaja.
      leaving.current = null;
      router.replace('/tickets');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setPaying(false);
    }
  };

  if (quote.isLoading) return <Screen><LoadingState label="Počítam cenu…" /></Screen>;
  if (quote.error) {
    return (
      <Screen>
        <ErrorState
          title="Ponuka sa nenačítala"
          message="Skús to prosím znova."
          onRetry={() => void quote.refetch()}
        />
      </Screen>
    );
  }

  const q = quote.data as ResaleQuote;

  if (!q.valid) {
    return (
      <Screen scroll>
        <Title>Táto ponuka už neplatí</Title>
        <Notice
          tone="warning"
          title={reasonTitle(q.reason)}
          body={reasonBody(q.reason)}
        />
        <Button
          title="Späť na burzu"
          variant="secondary"
          onPress={() => router.replace(`/resale/${q.event_id}`)}
        />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Title>Zhrnutie objednávky</Title>

      <View style={styles.badgeBlock}>
        <AuthenticityBadge authenticity={q.authenticity} />
        <Caption style={styles.explainer}>{authenticityExplainer(q.authenticity)}</Caption>
      </View>

      <View style={styles.bill}>
        <Line label={`Vstupenka${q.quantity > 1 ? ` × ${q.quantity}` : ''}`}
              value={formatMoney(q.ticket_price_cents, q.currency)} />
        <Line label="Poplatok burzy"
              value={formatMoney(q.buyer_fee_cents, q.currency)} />
        {q.delivery_fee_cents > 0 ? (
          <Line label="Doručenie"
                value={formatMoney(q.delivery_fee_cents, q.currency)} />
        ) : null}

        <Divider />

        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Spolu</Text>
          <Text style={styles.totalValue}>{formatMoney(q.total_cents, q.currency)}</Text>
        </View>
        <Caption style={styles.totalNote}>
          Toto je konečná suma. Nič ďalšie sa nepripočíta.
        </Caption>
      </View>

      {error ? <Notice tone="danger" title="Nepodarilo sa" body={error} /> : null}

      {reservation && secondsLeft > 0 ? (
        <View style={styles.held}>
          <Mono style={styles.clock}>{formatClock(secondsLeft)}</Mono>
          <Caption style={styles.heldNote}>
            Vstupenku ti držíme. Po uplynutí času sa vráti do predaja.
          </Caption>
        </View>
      ) : null}

      {reservation && secondsLeft <= 0 ? (
        <Notice
          tone="warning"
          title="Čas vypršal"
          body="Vstupenka sa vrátila do predaja. Skús ju podržať znova."
        />
      ) : null}

      {!reservation ? (
        <Button
          title={holding ? 'Držím…' : 'Podržať a pokračovať'}
          onPress={() => void hold()}
          disabled={holding}
        />
      ) : canTakePayment() ? (
        <Button
          title={paying ? 'Platím…' : `Zaplatiť ${formatMoney(q.total_cents, q.currency)}`}
          onPress={() => void pay()}
          disabled={secondsLeft <= 0 || paying}
        />
      ) : (
        // Radšej to povedať, než ukázať tlačidlo, ktoré nič nespraví.
        <Notice
          tone="warning"
          title="Platba tu zatiaľ nejde"
          body={unavailableMessage}
        />
      )}

      {/* Nezmizne po zaplatení a nie je to formalita: pri vstupenke z inej
          platformy je toto jediné, čo kupujúcemu naozaj garantujeme. */}
      <View style={styles.guarantee}>
        <Text style={styles.guaranteeTitle}>Peniaze držíme my</Text>
        <Caption>
          {q.source === 'blup'
            ? 'Vstupenka sa prepíše na teba hneď po zaplatení. Predajca dostane '
              + 'peniaze až po evente.'
            : 'Predajca dostane peniaze až po evente a až keď potvrdíš, že '
              + 'vstupenka fungovala. Ak nefungovala, vrátime ti ich.'}
        </Caption>
      </View>
    </Screen>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}</Text>
      <Mono style={styles.lineValue}>{value}</Mono>
    </View>
  );
}

function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Kódy zo servera preložené do vety.
 *
 * Kód sám je pre vývojára; človeku treba povedať, čo sa stalo a čo s tým.
 */
function reasonTitle(reason: string | null): string {
  switch (reason) {
    case 'LISTING_SOLD':     return 'Vstupenka je predaná';
    case 'LISTING_RESERVED': return 'Práve ju drží niekto iný';
    case 'LISTING_EXPIRED':  return 'Ponuka vypršala';
    case 'EVENT_CANCELLED':  return 'Event bol zrušený';
    case 'EVENT_FINISHED':   return 'Event sa už skončil';
    case 'OWN_LISTING':      return 'Toto je tvoja vlastná ponuka';
    case 'RESALE_DISABLED':  return 'Burza je dočasne vypnutá';
    default:                 return 'Ponuka nie je dostupná';
  }
}

function reasonBody(reason: string | null): string {
  switch (reason) {
    case 'LISTING_SOLD':
      return 'Niekto bol rýchlejší. Pozri sa, či na evente nie sú ďalšie ponuky.';
    case 'LISTING_RESERVED':
      return 'Držanie trvá pár minút. Ak ju nekúpi, vráti sa do predaja — skús to o chvíľu.';
    case 'OWN_LISTING':
      return 'Vlastnú vstupenku si kúpiť nemôžeš. Stiahnuť ju vieš v Predávam.';
    case 'EVENT_CANCELLED':
      return 'Organizátor event zrušil, takže sa už nepredáva.';
    default:
      return 'Skús to prosím znova alebo si pozri ostatné ponuky.';
  }
}

const styles = StyleSheet.create({
  badgeBlock: { gap: spacing.xs, marginBottom: spacing.sm },
  explainer: { lineHeight: 18 },

  bill: {
    padding: spacing.md,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  line: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  lineLabel: { ...typography.body, color: colors.textSecondary },
  lineValue: { color: colors.text },

  totalRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  totalLabel: { ...typography.bodyStrong, color: colors.text },
  totalValue: { ...typography.subheading, color: colors.text },
  totalNote: { marginTop: 2 },

  held: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    padding: spacing.md, marginBottom: spacing.md,
    borderRadius: radius.card,
    backgroundColor: colors.accentSoft,
    borderWidth: 1, borderColor: colors.accentBorder,
  },
  clock: { ...typography.subheading, color: colors.accent },
  heldNote: { flex: 1 },

  guarantee: {
    marginTop: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
  },
  guaranteeTitle: { ...typography.bodyStrong, color: colors.text },
});
