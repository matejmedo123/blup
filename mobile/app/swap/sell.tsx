import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  createResaleListing, getResalePriceHint, getSwapFees, type ResaleSource,
} from '@/api/resale';
import { getEvent } from '@/api/events';
import { PriceAdvice } from '@/swap/PriceAdvice';
import { getMyTickets } from '@/api/tickets';
import type { TicketWithEvent } from '@/types/models';
import { AuthenticityBadge } from '@/components/AuthenticityBadge';
import {
  Button, Caption, Input, Notice, Screen, SectionHeader, Title,
} from '@/components/ui';
import { messageFor } from '@/lib/errors';
import { formatEventDate, formatMoney } from '@/lib/format';
import { colors, radius, spacing, typography } from '@/theme';
import { swapAccountRoute } from '@/swap/SwapGuestGate';

/**
 * Vypísanie vstupenky na predaj.
 *
 * Obrazovka sa hneď na začiatku pýta na to jediné, čo naozaj rozhoduje: či je
 * vstupenka z BLUPu alebo odinakiaľ. Nie je to administratívna otázka —
 * rozhoduje o tom, čo sa kupujúcemu sľúbi.
 *
 * Pri našej vstupenke sa vyberá zo zoznamu tých, ktoré človek naozaj má:
 * číslo sa neopisuje ručne, lebo prevod potom robí server sám a nemá čo
 * hľadať. Pri cudzej sa údaje zadávajú, ale appka nikde nepovie, že sú
 * overené, lebo overené nie sú.
 *
 * Cenu si určuje predajca. Pôvodná cena nie je strop — je to len údaj, ktorý
 * uvidí kupujúci. Namiesto zákazu dostane predajca radu: `PriceAdvice` mu
 * ukáže, za koľko sa tá istá vstupenka na tom istom evente ponúka a predáva,
 * a navrhne tri ceny podľa toho, či chce predať rýchlo alebo draho.
 */
function SellTicketScreen() {
  const queryClient = useQueryClient();

  /**
   * Externú vstupenku vypisuješ na konkrétny event, a ten sa sem dostane z
   * URL — z tlačidla „Predať" na stránke eventu. Bez neho by obrazovka nemala
   * ku ktorému eventu ponuku pripnúť, a preto na to v tom prípade pošle.
   */
  const params = useLocalSearchParams<{ event?: string }>();
  const eventParam = typeof params.event === 'string' ? params.event : null;

  const [source, setSource] = useState<ResaleSource>('blup');
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [price, setPrice] = useState('');
  const [section, setSection] = useState('');
  const [rowLabel, setRowLabel] = useState('');
  const [seatLabel, setSeatLabel] = useState('');
  const [provider, setProvider] = useState('');
  const [reference, setReference] = useState('');
  const [faceValue, setFaceValue] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tickets = useQuery({ queryKey: ['tickets', 'mine'], queryFn: getMyTickets });

  /**
   * Sadzby zo servera, nie číslo v kóde.
   *
   * Predajca musí vidieť, koľko dostane, EŠTE PREDTÝM než ponuku zverejní.
   * Dozvedieť sa o provízii až z prehľadu po predaji je presne to, čo ľudí
   * na takýchto službách najviac nahnevá.
   */
  const fees = useQuery({ queryKey: ['swap', 'fees'], queryFn: getSwapFees, staleTime: 300_000 });

  /**
   * Predať sa dá len to, čo ešte nebolo použité a na event, ktorý ešte bude.
   *
   * Dátum je v `t.event.start_at`, nie v `t.event_start_at`. Písané cez `any`
   * to prešlo typovou kontrolou aj buildom, ale `new Date(undefined ?? 0)` je
   * rok 1970 — takže podmienka „event ešte bude" neplatila NIKDY a obrazovka
   * každému napísala „Nemáš čo predať". Odhalil to až screenshot; preto je tu
   * teraz skutočný typ a nie `any`.
   */
  const sellable = useMemo(
    () => (tickets.data ?? []).filter(
      (t) => t.status === 'valid' && !t.checked_in_at
        && new Date(t.event?.start_at ?? 0).getTime() > Date.now(),
    ),
    [tickets.data],
  );

  /**
   * Príchod z eventu: vyber rovno to, čo na ten event mám.
   *
   * Keď vstupenku z BLUPu na ten event mám, obrazovka ju predvyberie. Keď
   * nemám, prepne sa na „mám ju odinakiaľ" — inak by človek pristál na zozname
   * vstupeniek, v ktorom tá jeho nie je, a myslel si, že sa nedá nič robiť.
   * Beží raz; potom už rozhoduje človek.
   */
  const settled = useRef(false);
  useEffect(() => {
    if (settled.current || !eventParam || !tickets.isSuccess) return;
    settled.current = true;
    const mine = sellable.find((t) => t.event_id === eventParam);
    if (mine) {
      setTicketId(mine.id);
      setPrice((current) => current || ((mine.price_cents ?? 0) / 100).toFixed(2).replace('.', ','));
    } else {
      setSource('external');
    }
  }, [eventParam, sellable, tickets.isSuccess]);

  const chosen: TicketWithEvent | undefined = sellable.find((t) => t.id === ticketId);

  /** Event, ku ktorému ponuka patrí — z vybranej vstupenky alebo z URL. */
  const eventId = source === 'blup' ? chosen?.event_id ?? null : eventParam;

  const externalEvent = useQuery({
    queryKey: ['event', eventParam],
    queryFn: () => getEvent(eventParam!),
    enabled: source === 'external' && !!eventParam,
  });

  /**
   * Rada k cene. Pýta sa až vtedy, keď je jasné, na ktorý event — inak by to
   * bol dotaz do prázdna pri každom otvorení obrazovky.
   */
  /**
   * Nominálnu hodnotu posielame len pri vlastnej BLUP vstupenke.
   *
   * Pri externej by to bola cena MOJEJ vstupenky na ten event — a rada by
   * tvrdila „v predpredaji stála 19 €" o vstupenke, ktorú predávam odinakiaľ
   * a o ktorej nič nevieme.
   */
  const hintTicketId = source === 'blup' ? chosen?.id ?? null : null;

  const hint = useQuery({
    queryKey: ['swap', 'price-hint', eventId, hintTicketId],
    queryFn: () => getResalePriceHint(eventId!, hintTicketId),
    enabled: !!eventId,
    staleTime: 60_000,
  });

  const cents = Math.round(Number(price.replace(',', '.')) * 100);
  const faceCents = Math.round(Number(faceValue.replace(',', '.')) * 100);
  const qty = Math.round(Number(quantity));

  // Rovnaký výpočet ako na serveri (celočíselné delenie desaťtisícom), aby sa
  // náhľad a skutočná suma nelíšili o cent.
  const sellerFeeBps = fees.data?.seller_fee_bps ?? 0;
  const organizerShareBps = fees.data?.organizer_share_bps ?? 0;
  const feeCents = Number.isFinite(cents) && cents > 0
    ? Math.floor((cents * sellerFeeBps) / 10000)
    : 0;
  const netCents = Number.isFinite(cents) && cents > 0 ? cents - feeCents : 0;

  const minPrice = fees.data?.min_price_cents ?? 50;
  const tooLow = Number.isFinite(cents) && cents > 0 && cents < minPrice;
  const currency = chosen?.currency ?? externalEvent.data?.currency ?? 'EUR';

  const submit = async () => {
    setError(null);
    if (!Number.isFinite(cents) || cents <= 0) {
      setError('Zadaj cenu.');
      return;
    }
    if (cents < minPrice) {
      setError(`Najmenej ${formatMoney(minPrice, currency)} — nižšiu platbu brána nespracuje.`);
      return;
    }
    setBusy(true);
    try {
      if (source === 'blup') {
        if (!chosen) { setError('Vyber vstupenku.'); setBusy(false); return; }
        await createResaleListing({
          eventId: chosen.event_id,
          source: 'blup',
          ticketId: chosen.id,
          priceCents: cents,
          section: section || null,
          rowLabel: rowLabel || null,
          seatLabel: seatLabel || null,
          note: note || null,
        });
      } else {
        if (!eventParam) {
          setError('Otvor event, na ktorý vstupenku máš, a daj tam Predať.');
          setBusy(false);
          return;
        }
        if (!Number.isFinite(qty) || qty < 1 || qty > 20) {
          setError('Počet vstupeniek musí byť od 1 do 20.');
          setBusy(false);
          return;
        }
        await createResaleListing({
          eventId: eventParam,
          source: 'external',
          priceCents: cents,
          quantity: qty,
          deliveryMethod: 'file',
          externalProvider: provider || null,
          externalReference: reference || null,
          faceValueCents: Number.isFinite(faceCents) && faceCents > 0 ? faceCents : null,
          section: section || null,
          rowLabel: rowLabel || null,
          seatLabel: seatLabel || null,
          note: note || null,
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['resale'] });
      await queryClient.invalidateQueries({ queryKey: ['swap'] });
      router.replace('/swap/selling');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll>
      {/* Hlavička hore už hovorí „Predať vstupenku"; druhý raz pod ňou je to
          ten istý text dvakrát. */}
      <SectionHeader title="Odkiaľ je vstupenka" />
      <View style={styles.sources}>
        <SourceOption
          active={source === 'blup'}
          onPress={() => setSource('blup')}
          title="Kúpil som ju v BLUPe"
          body="Prevedieme ju na kupujúceho a tvoj QR kód prestane platiť. Kupujúci vidí, že je overená."
          authenticity="verified"
        />
        <SourceOption
          active={source === 'external'}
          onPress={() => setSource('external')}
          title="Mám ju odinakiaľ"
          body="Pravosť overiť nevieme a kupujúcemu to povieme. Peniaze dostaneš, až keď potvrdí, že fungovala."
          authenticity="protected"
        />
      </View>

      {source === 'blup' ? (
        <>
          <SectionHeader title="Ktorú vstupenku" />
          {sellable.length === 0 ? (
            <Notice
              tone="accent"
              title="Nemáš čo predať"
              body="Predať sa dá len nepoužitá vstupenka na event, ktorý ešte bude."
            />
          ) : (
            sellable.map((t) => (
              <Pressable
                key={t.id}
                onPress={() => {
                  setTicketId(t.id);
                  // Pôvodná cena ako východzí bod, nie ako strop — odtiaľ sa
                  // dá ísť hore aj dole podľa toho, čo poradí trh nižšie.
                  if (!price) setPrice(((t.price_cents ?? 0) / 100).toFixed(2).replace('.', ','));
                }}
                style={[styles.ticket, ticketId === t.id && styles.ticketOn]}
              >
                <View style={styles.ticketMain}>
                  <Text style={styles.ticketTitle} numberOfLines={1}>
                    {t.event?.title ?? 'Event'}
                  </Text>
                  <Caption>{formatEventDate(t.event?.start_at ?? '')}</Caption>
                </View>
                <Text style={styles.ticketPrice}>
                  {formatMoney(t.price_cents ?? 0, t.currency ?? 'EUR')}
                </Text>
              </Pressable>
            ))
          )}
        </>
      ) : eventParam ? (
        <>
          <SectionHeader title="Na ktorý event" />
          <View style={styles.eventBox}>
            <Text style={styles.ticketTitle} numberOfLines={2}>
              {externalEvent.data?.title ?? 'Načítavam…'}
            </Text>
            {externalEvent.data ? (
              <Caption>{formatEventDate(externalEvent.data.start_at)}</Caption>
            ) : null}
          </View>

          <SectionHeader title="Odkiaľ ju máš" />
          <Input
            label="Predajca (nepovinné)"
            value={provider}
            onChangeText={setProvider}
            placeholder="Ticketportal, Predpredaj…"
          />
          <Input
            label="Číslo objednávky (nepovinné)"
            value={reference}
            onChangeText={setReference}
            placeholder="Kupujúci ho neuvidí, slúži pri spore."
          />
          <Input
            label="Pôvodná cena (nepovinné)"
            value={faceValue}
            onChangeText={setFaceValue}
            keyboardType="decimal-pad"
            placeholder="0,00"
          />
          <Input
            label="Počet vstupeniek"
            value={quantity}
            onChangeText={setQuantity}
            keyboardType="number-pad"
            placeholder="1"
          />
        </>
      ) : (
        <Notice
          tone="accent"
          title="Otvor event a daj Predať"
          body="Vstupenku odinakiaľ vypisuješ priamo na evente, ku ktorému patrí — inak by nebolo kam ju pripnúť."
        />
      )}

      {eventId ? (
        <>
          <SectionHeader title="Za koľko" />
          <Input
            label="Cena za vstupenku"
            value={price}
            onChangeText={setPrice}
            keyboardType="decimal-pad"
            placeholder="0,00"
          />
          <Caption style={tooLow ? styles.capBad : undefined}>
            {tooLow
              ? `Najmenej ${formatMoney(minPrice, currency)} — nižšiu platbu brána nespracuje.`
              : 'Cenu si určuješ ty. Pôvodná cena je pre kupujúceho len informácia.'}
          </Caption>

          {/* Rada namiesto zákazu: koľko za ňu pýtajú ostatní a za koľko sa
              reálne predáva. Návrh sa dá klepnutím vložiť do poľa vyššie. */}
          {hint.data ? (
            <PriceAdvice
              hint={hint.data}
              cents={cents}
              onPick={(value) => setPrice((value / 100).toFixed(2).replace('.', ','))}
            />
          ) : null}

          {/* Koľko z toho príde predajcovi. Tu, pri poli s cenou, a nie až v
              prehľade po predaji — vtedy už je neskoro sa rozhodnúť inak. */}
          {netCents > 0 ? (
            <View style={styles.payout}>
              <View style={styles.payoutRow}>
                <Text style={styles.payoutLabel}>Kupujúci zaplatí</Text>
                <Text style={styles.payoutValue}>
                  {formatMoney(cents, currency)}
                </Text>
              </View>
              <View style={styles.payoutRow}>
                <Text style={styles.payoutLabel}>
                  Provízia SWAPu ({(sellerFeeBps / 100).toFixed(0)} %)
                </Text>
                <Text style={styles.payoutValue}>
                  −{formatMoney(feeCents, currency)}
                </Text>
              </View>
              <View style={[styles.payoutRow, styles.payoutTotal]}>
                <Text style={styles.payoutStrong}>Dostaneš</Text>
                <Text style={styles.payoutStrong}>
                  {formatMoney(netCents, currency)}
                </Text>
              </View>
              <Caption style={styles.payoutNote}>
                Peniaze ti pošleme po evente.
                {/* Kam ide časť provízie. Pri našej vstupenke dostane
                    organizátor eventu podiel — je to z tých istých 15 %, nie
                    navyše, a predajca má vedieť, že tým podporil aj toho, kto
                    event robí. */}
                {source === 'blup' && organizerShareBps > 0
                  ? ` Z provízie ide ${(organizerShareBps / 100).toFixed(0)} % organizátorovi eventu.`
                  : ''}
              </Caption>
            </View>
          ) : null}

          <SectionHeader title="Kde sa sedí (nepovinné)" />
          <Input label="Sektor" value={section} onChangeText={setSection} placeholder="A" />
          <Input label="Rad" value={rowLabel} onChangeText={setRowLabel} placeholder="10" />
          <Input label="Miesto" value={seatLabel} onChangeText={setSeatLabel} placeholder="15" />

          <Input
            label="Poznámka pre kupujúceho (nepovinné)"
            value={note}
            onChangeText={setNote}
            multiline
            placeholder="Napríklad prečo nemôžeš ísť."
          />
        </>
      ) : null}

      {error ? <Notice tone="danger" title="Nepodarilo sa" body={error} /> : null}

      {eventId ? (
        <Button
          title={busy ? 'Vypisujem…' : 'Ponúknuť na SWAPe'}
          onPress={() => void submit()}
          disabled={busy || !price || tooLow}
        />
      ) : null}
    </Screen>
  );
}

function SourceOption({
  active, onPress, title, body, authenticity,
}: {
  active: boolean;
  onPress: () => void;
  title: string;
  body: string;
  authenticity: 'verified' | 'protected';
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.source, active && styles.sourceOn]}
      accessibilityRole="button"
    >
      <View style={styles.sourceHead}>
        <Text style={styles.sourceTitle}>{title}</Text>
        <AuthenticityBadge authenticity={authenticity} size="s" />
      </View>
      <Caption style={styles.sourceBody}>{body}</Caption>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sources: { gap: spacing.sm, marginBottom: spacing.sm },
  source: {
    padding: spacing.md,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: spacing.xs,
  },
  sourceOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  sourceHead: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', gap: spacing.sm, flexWrap: 'wrap',
  },
  sourceTitle: { ...typography.bodyStrong, color: colors.text },
  sourceBody: { lineHeight: 18 },

  ticket: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.card,
    borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
    marginBottom: spacing.xs,
  },
  ticketOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  eventBox: {
    padding: spacing.md,
    borderRadius: radius.card,
    borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
    marginBottom: spacing.xs,
  },
  ticketMain: { flex: 1 },
  ticketTitle: { ...typography.bodyStrong, color: colors.text },
  ticketPrice: { ...typography.body, color: colors.textSecondary },

  capBad: { color: colors.danger },

  payout: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: 4,
  },
  payoutRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  payoutTotal: {
    borderTopWidth: 1, borderTopColor: colors.border,
    paddingTop: spacing.xs, marginTop: spacing.xs,
  },
  payoutLabel: { ...typography.body, color: colors.textSecondary },
  payoutValue: { ...typography.body, color: colors.text },
  payoutStrong: { ...typography.bodyStrong, color: colors.text },
  payoutNote: { marginTop: 2 },
});

export default swapAccountRoute(
  'Vstupenku treba previesť z tvojho účtu a peniaze ti máme kam poslať.',
  SellTicketScreen,
);
