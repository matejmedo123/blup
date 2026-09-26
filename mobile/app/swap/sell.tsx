import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { createResaleListing, getSwapFees, type ResaleSource } from '@/api/resale';
import { getMyTickets } from '@/api/tickets';
import { AuthenticityBadge } from '@/components/AuthenticityBadge';
import {
  Button, Caption, Input, Notice, Screen, SectionHeader, Title,
} from '@/components/ui';
import { messageFor } from '@/lib/errors';
import { formatEventDate, formatMoney } from '@/lib/format';
import { colors, radius, spacing, typography } from '@/theme';

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
 */
export default function SellTicketScreen() {
  const queryClient = useQueryClient();

  const [source, setSource] = useState<ResaleSource>('blup');
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [price, setPrice] = useState('');
  const [section, setSection] = useState('');
  const [rowLabel, setRowLabel] = useState('');
  const [seatLabel, setSeatLabel] = useState('');
  const [provider, setProvider] = useState('');
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

  // Predať sa dá len to, čo ešte nebolo použité a na event, ktorý ešte bude.
  const sellable = useMemo(
    () => (tickets.data ?? []).filter(
      (t: any) => t.status === 'valid' && !t.checked_in_at
        && new Date(t.event_start_at ?? t.start_at ?? 0).getTime() > Date.now(),
    ),
    [tickets.data],
  );

  const chosen = sellable.find((t: any) => t.id === ticketId);
  const cents = Math.round(Number(price.replace(',', '.')) * 100);

  // Rovnaký výpočet ako na serveri (celočíselné delenie desaťtisícom), aby sa
  // náhľad a skutočná suma nelíšili o cent.
  const sellerFeeBps = fees.data?.seller_fee_bps ?? 0;
  const feeCents = Number.isFinite(cents) && cents > 0
    ? Math.floor((cents * sellerFeeBps) / 10000)
    : 0;
  const netCents = Number.isFinite(cents) && cents > 0 ? cents - feeCents : 0;
  const overCap = Boolean(
    chosen && Number.isFinite(cents) && cents > (chosen.price_cents ?? 0),
  );

  const submit = async () => {
    setError(null);
    if (!Number.isFinite(cents) || cents < 0) {
      setError('Zadaj cenu.');
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
        setError('Externú vstupenku zatiaľ vyberáš cez event — otvor ho a daj Predať.');
        setBusy(false);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ['resale'] });
      router.replace('/swap/selling');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll>
      <Title>Predať vstupenku</Title>

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
            sellable.map((t: any) => (
              <Pressable
                key={t.id}
                onPress={() => {
                  setTicketId(t.id);
                  // Pôvodná cena je zároveň strop, tak ju rovno ponúkneme.
                  if (!price) setPrice(((t.price_cents ?? 0) / 100).toFixed(2));
                }}
                style={[styles.ticket, ticketId === t.id && styles.ticketOn]}
              >
                <View style={styles.ticketMain}>
                  <Text style={styles.ticketTitle} numberOfLines={1}>
                    {t.event_title ?? 'Event'}
                  </Text>
                  <Caption>{formatEventDate(t.event_start_at ?? t.start_at)}</Caption>
                </View>
                <Text style={styles.ticketPrice}>
                  {formatMoney(t.price_cents ?? 0, t.currency ?? 'EUR')}
                </Text>
              </Pressable>
            ))
          )}
        </>
      ) : (
        <Notice
          tone="accent"
          title="Otvor event a daj Predať"
          body="Vstupenku odinakiaľ vypisuješ priamo na evente, ku ktorému patrí."
        />
      )}

      {source === 'blup' && chosen ? (
        <>
          <SectionHeader title="Za koľko" />
          <Input
            label="Cena za vstupenku"
            value={price}
            onChangeText={setPrice}
            keyboardType="decimal-pad"
            placeholder="0,00"
          />
          {/* Strop nie je prekvapenie po odoslaní — človek ho vidí, kým píše. */}
          <Caption style={overCap ? styles.capBad : undefined}>
            {overCap
              ? `Viac než ${formatMoney(chosen.price_cents ?? 0, chosen.currency ?? 'EUR')} `
                + 'pýtať nemôžeš — toľko si za ňu zaplatil.'
              : `Najviac ${formatMoney(chosen.price_cents ?? 0, chosen.currency ?? 'EUR')}, `
                + 'teda toľko, koľko si za ňu zaplatil.'}
          </Caption>

          {/* Koľko z toho príde predajcovi. Tu, pri poli s cenou, a nie až v
              prehľade po predaji — vtedy už je neskoro sa rozhodnúť inak. */}
          {netCents > 0 ? (
            <View style={styles.payout}>
              <View style={styles.payoutRow}>
                <Text style={styles.payoutLabel}>Kupujúci zaplatí</Text>
                <Text style={styles.payoutValue}>
                  {formatMoney(cents, chosen.currency ?? 'EUR')}
                </Text>
              </View>
              <View style={styles.payoutRow}>
                <Text style={styles.payoutLabel}>
                  Provízia SWAPu ({(sellerFeeBps / 100).toFixed(0)} %)
                </Text>
                <Text style={styles.payoutValue}>
                  −{formatMoney(feeCents, chosen.currency ?? 'EUR')}
                </Text>
              </View>
              <View style={[styles.payoutRow, styles.payoutTotal]}>
                <Text style={styles.payoutStrong}>Dostaneš</Text>
                <Text style={styles.payoutStrong}>
                  {formatMoney(netCents, chosen.currency ?? 'EUR')}
                </Text>
              </View>
              <Caption style={styles.payoutNote}>
                Peniaze ti pošleme po evente.
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

      {source === 'blup' ? (
        <Button
          title={busy ? 'Vypisujem…' : 'Ponúknuť na SWAPe'}
          onPress={() => void submit()}
          disabled={busy || !chosen || overCap || !price}
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
