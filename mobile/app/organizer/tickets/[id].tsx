import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getEvent } from '@/api/events';
import { createTicketType, updateTicketType } from '@/api/organizations';
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

  const event = useQuery({
    queryKey: ['event', id],
    queryFn: () => getEvent(id!),
    enabled: Boolean(id),
  });

  if (event.isLoading) return <Screen><LoadingState /></Screen>;

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
          </View>
        ))
      )}

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
  flex: { flex: 1 },
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
