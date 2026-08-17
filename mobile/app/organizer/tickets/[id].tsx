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
      setError('Name the ticket, e.g. "Early bird".');
      return;
    }
    if (!Number.isFinite(priceValue) || priceValue < 0) {
      setError('Set a valid price.');
      return;
    }
    if (!Number.isInteger(quantityValue) || quantityValue < 1) {
      setError('How many of these exist?');
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

      {error ? <Notice tone="danger" title="Could not save" body={error} /> : null}

      {event.data && event.data.is_free ? (
        <Notice
          tone="warning"
          title="This is a free event"
          body="Turn off ‘Free event’ in the event settings before adding paid tickets."
        />
      ) : null}

      <SectionHeader title="Existing tickets" />
      {(event.data?.ticket_types ?? []).length === 0 ? (
        <Body muted>None yet. Add the first type below.</Body>
      ) : (
        (event.data?.ticket_types ?? []).map((ticket) => (
          <View key={ticket.id} style={styles.row}>
            <View style={styles.flex}>
              <Text style={styles.rowTitle}>{ticket.name}</Text>
              <Caption>
                {ticket.quantity_sold}/{ticket.quantity_total} sold · max {ticket.max_per_order} per order
              </Caption>
            </View>
            <Text style={styles.price}>{formatPrice(ticket.price_cents, ticket.currency)}</Text>
            <Button
              title={ticket.is_active ? 'Pause' : 'Resume'}
              variant="ghost"
              compact
              onPress={() => toggleActive(ticket.id, ticket.is_active)}
            />
          </View>
        ))
      )}

      <SectionHeader title="Add a ticket type" />
      <Input label="Name" value={name} onChangeText={setName} placeholder="Early bird" editable={!saving} />
      <Input label="Price (EUR)" value={price} onChangeText={setPrice} placeholder="15" keyboardType="decimal-pad" editable={!saving} />
      <Input label="How many" value={quantity} onChangeText={setQuantity} placeholder="100" keyboardType="number-pad" editable={!saving} />
      <Input label="Max per order" value={maxPerOrder} onChangeText={setMaxPerOrder} keyboardType="number-pad" editable={!saving} />

      <Button title="Add ticket type" onPress={submit} loading={saving} />
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
