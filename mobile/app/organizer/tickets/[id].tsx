import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getEvent } from '@/api/events';
import {
  createTicketType, getCompSummary, issueCompTickets, updateTicketType,
} from '@/api/organizations';
import { messageFor } from '@/lib/errors';
import { formatPrice } from '@/lib/format';
import {
  Badge, Body, Button, Caption, Input, LoadingState, Notice, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/** Ticket types for one event. Only a verified organization can create these. */
export default function TicketTypesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const [maxPerOrder, setMaxPerOrder] = useState('6');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Giving a ticket away.
  const [compFor, setCompFor] = useState<string | null>(null);
  const [compTo, setCompTo] = useState('');
  const [compQty, setCompQty] = useState('1');
  const [compNote, setCompNote] = useState('');
  const [compName, setCompName] = useState('');
  const [compBusy, setCompBusy] = useState(false);
  const [compDone, setCompDone] = useState<string | null>(null);

  const event = useQuery({
    queryKey: ['event', id],
    queryFn: () => getEvent(id!),
    enabled: Boolean(id),
  });

  // Above the early return below: a hook after it unmounts the whole screen.
  const comps = useQuery({
    queryKey: ['event', id, 'comps'],
    queryFn: () => getCompSummary(id!),
    enabled: Boolean(id),
  });

  if (event.isLoading) return <Screen><LoadingState /></Screen>;

  const giveAway = async () => {
    if (!compFor) return;
    setError(null);
    setCompDone(null);

    const qty = Number(compQty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) {
      setError('Počet musí byť celé číslo od 1 do 50.');
      return;
    }
    const to = compTo.trim();
    if (!to) {
      setError('Napíš @username alebo e-mail.');
      return;
    }
    if (!to.startsWith('@') && !to.includes('@')) {
      setError('Potrebujem @username niekoho z BLUPu, alebo e-mailovú adresu.');
      return;
    }

    setCompBusy(true);
    try {
      const issued = await issueCompTickets(
        compFor, compTo.trim(), qty, compNote.trim() || null, compName.trim() || null,
      );
      setCompDone(
        `Odoslané: ${issued} ${issued === 1 ? 'vstupenka' : 'vstupenky'}. `
        + 'QR kód mu prišiel e-mailom — účet na vstup nepotrebuje.',
      );
      setCompTo('');
      setCompNote('');
      setCompName('');
      setCompQty('1');
      setCompFor(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['event', id] }),
        queryClient.invalidateQueries({ queryKey: ['event', id, 'comps'] }),
      ]);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setCompBusy(false);
    }
  };

  const submit = async () => {
    setError(null);

    const priceValue = Number(price.replace(',', '.'));
    const quantityValue = Number(quantity);

    if (name.trim().length < 2) {
      setError('Pomenuj vstupenku, napr. „Early bird“.');
      return;
    }
    if (!Number.isFinite(priceValue) || priceValue < 0) {
      setError('Nastav platnú cenu.');
      return;
    }
    if (!Number.isInteger(quantityValue) || quantityValue < 1) {
      setError('Koľko ich je?');
      return;
    }

    setSaving(true);
    try {
      await createTicketType({
        eventId: id!,
        name,
        priceCents: Math.round(priceValue * 100),
        quantityTotal: quantityValue,
        maxPerOrder: Number(maxPerOrder) || 6,
        currency: event.data?.currency ?? 'EUR',
      });

      setName('');
      setPrice('');
      setQuantity('');
      await queryClient.invalidateQueries({ queryKey: ['event', id] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (ticketId: string, isActive: boolean) => {
    try {
      await updateTicketType(ticketId, { is_active: !isActive });
      await queryClient.invalidateQueries({ queryKey: ['event', id] });
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  return (
    <Screen scroll>
      <Text style={styles.title}>{event.data?.title}</Text>

      {error ? <Notice tone="danger" title="Nepodarilo sa uložiť" body={error} /> : null}

      {event.data && event.data.is_free ? (
        <Notice
          tone="warning"
          title="Toto je event zdarma"
          body="Pred pridaním platených vstupeniek vypni v nastaveniach eventu „Event zdarma“."
        />
      ) : null}

      <SectionHeader title="Existujúce vstupenky" />
      {(event.data?.ticket_types ?? []).length === 0 ? (
        <Body muted>Zatiaľ žiadne. Prvý typ pridáš nižšie.</Body>
      ) : (
        (event.data?.ticket_types ?? []).map((ticket) => (
          <View key={ticket.id} style={styles.row}>
            <View style={styles.flex}>
              <Text style={styles.rowTitle}>{ticket.name}</Text>
              <Caption>
                {ticket.quantity_sold}/{ticket.quantity_total} predaných · max {ticket.max_per_order} na objednávku
              </Caption>
            </View>
            <Text style={styles.price}>{formatPrice(ticket.price_cents, ticket.currency)}</Text>
            <Button
              title={ticket.is_active ? 'Pozastaviť' : 'Obnoviť'}
              variant="ghost"
              compact
              onPress={() => toggleActive(ticket.id, ticket.is_active)}
            />
            <Button
              title="Darovať"
              variant="ghost"
              compact
              onPress={() => {
                setCompDone(null);
                setError(null);
                setCompFor(compFor === ticket.id ? null : ticket.id);
              }}
            />
          </View>
        ))
      )}

      {/* --- giving one away ------------------------------------------------ */}
      {compFor ? (
        <View style={styles.compBox}>
          <SectionHeader title="Darovať vstupenku" />
          <Body muted>
            Pre výhercu súťaže, hosťa alebo médiá. Vstupenka je plnohodnotná —
            rovnaký QR kód, rovnaký skener — len stojí nula. Do tržieb sa
            nepočíta, ale miesto na akcii zaberie.
          </Body>
          <Input
            label="Komu"
            value={compTo}
            onChangeText={setCompTo}
            placeholder="@username alebo e-mail"
            autoCapitalize="none"
            keyboardType="email-address"
            editable={!compBusy}
            hint="Účet nepotrebuje. Na e-mail mu príde QR kód, ktorý pri vstupe stačí."
          />
          <Input
            label="Meno (nepovinné)"
            value={compName}
            onChangeText={setCompName}
            placeholder="Jana Nováková"
            editable={!compBusy}
            hint="Objaví sa na vstupenke a v oslovení v e-maili."
          />
          <Input
            label="Počet"
            value={compQty}
            onChangeText={setCompQty}
            keyboardType="number-pad"
            editable={!compBusy}
          />
          <Input
            label="Odkaz (nepovinné)"
            value={compNote}
            onChangeText={setCompNote}
            placeholder="Výherca súťaže na Instagrame"
            editable={!compBusy}
            hint="Uvidí ho v notifikácii a zostane pri vstupenke."
          />
          <Button title="Poslať vstupenku" onPress={giveAway} loading={compBusy} />
          <Button title="Zrušiť" variant="ghost" onPress={() => setCompFor(null)} />
        </View>
      ) : null}

      {compDone ? <Notice tone="success" title="Odoslané" body={compDone} /> : null}

      {(comps.data?.issued ?? 0) > 0 ? (
        <Caption>
          Darované vstupenky: {comps.data?.issued}
          {comps.data?.checked_in ? ` · ${comps.data.checked_in} použitých` : ''}
          {' '}· do tržieb sa nepočítajú
        </Caption>
      ) : null}

      <SectionHeader title="Pridať typ vstupenky" />
      <Input label="Názov" value={name} onChangeText={setName} placeholder="Early bird" editable={!saving} />
      <Input label="Cena (EUR)" value={price} onChangeText={setPrice} placeholder="15" keyboardType="decimal-pad" editable={!saving} />
      <Input label="Počet kusov" value={quantity} onChangeText={setQuantity} placeholder="100" keyboardType="number-pad" editable={!saving} />
      <Input label="Max na objednávku" value={maxPerOrder} onChangeText={setMaxPerOrder} keyboardType="number-pad" editable={!saving} />

      <Button title="Pridať typ vstupenky" onPress={submit} loading={saving} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  compBox: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
  title: { ...typography.heading, color: colors.text },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowTitle: { ...typography.bodyStrong, color: colors.text },
  price: { ...typography.subheading, color: colors.text },
});
