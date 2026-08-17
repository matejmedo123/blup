import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import QRCode from 'react-native-qrcode-svg';

import { getTicket, ticketQrPayload } from '@/api/tickets';
import { messageFor } from '@/lib/errors';
import { formatEventDateLong, formatPrice, formatRelative } from '@/lib/format';
import {
  Badge, Body, Caption, Divider, ErrorState, LoadingState, Notice, Screen,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * The ticket itself. The QR encodes the ticket code plus its server-side secret;
 * scanning it calls check_in_ticket(), which verifies the secret, that the
 * scanner runs the event, and that the ticket has not already been used.
 */
export default function TicketScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['ticket', id],
    queryFn: () => getTicket(id!),
    enabled: Boolean(id),
  });

  if (isLoading) return <Screen><LoadingState /></Screen>;

  if (isError || !data) {
    return (
      <Screen>
        <ErrorState
          message={error ? messageFor(error) : 'This ticket could not be found.'}
          onRetry={() => void refetch()}
        />
      </Screen>
    );
  }

  const isUsable = data.status === 'valid';

  return (
    <Screen scroll>
      <View style={styles.card}>
        <Text style={styles.eventTitle}>{data.event?.title ?? 'Event'}</Text>
        {data.event ? <Caption>{formatEventDateLong(data.event.start_at)}</Caption> : null}
        {data.event?.venue_name ? <Caption>{data.event.venue_name}</Caption> : null}

        <View style={styles.qrWrapper}>
          {isUsable ? (
            <QRCode
              value={ticketQrPayload(data)}
              size={220}
              backgroundColor="#FFFFFF"
              color="#000000"
            />
          ) : (
            <View style={styles.qrDisabled}>
              <Text style={styles.qrDisabledEmoji}>
                {data.status === 'used' ? '✓' : '✕'}
              </Text>
              <Body muted>
                {data.status === 'used'
                  ? 'Already checked in'
                  : data.status === 'refunded'
                    ? 'Refunded'
                    : 'Cancelled'}
              </Body>
            </View>
          )}
        </View>

        <Text style={styles.code}>{data.code}</Text>
        <Badge tone={isUsable ? 'success' : 'neutral'} label={data.status.toUpperCase()} />
      </View>

      {data.checked_in_at ? (
        <Notice
          tone="accent"
          title="Checked in"
          body={`Scanned at the door ${formatRelative(data.checked_in_at)}.`}
        />
      ) : null}

      <Divider />

      <View style={styles.detailRow}>
        <Caption>Paid</Caption>
        <Body>{formatPrice(data.price_cents, data.currency)}</Body>
      </View>
      <View style={styles.detailRow}>
        <Caption>Issued</Caption>
        <Body>{formatRelative(data.created_at)}</Body>
      </View>

      <Caption style={styles.footnote}>
        Keep this screen for the door. The code is validated against BLUP’s servers, so a screenshot
        of someone else’s ticket will not get anyone in.
      </Caption>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.xl,
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
  },
  eventTitle: { ...typography.heading, color: colors.text, textAlign: 'center' },

  qrWrapper: {
    backgroundColor: '#FFFFFF',
    padding: spacing.lg,
    borderRadius: radius.lg,
    marginVertical: spacing.xl,
    minHeight: 252,
    minWidth: 252,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrDisabled: { alignItems: 'center', gap: spacing.sm },
  qrDisabledEmoji: { fontSize: 56, color: colors.textInverse },

  code: { ...typography.subheading, color: colors.text, letterSpacing: 2 },

  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  footnote: { marginTop: spacing.xl, textAlign: 'center' },
});
