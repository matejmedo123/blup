import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'react-native-qrcode-svg';

import {
  getTicket, getTicketEmail, getTicketEmailStatus, resendTicketEmail, ticketQrPayload,
} from '@/api/tickets';
import { SEAT_KIND_LABEL, type SeatKind } from '@/api/seating';
import { messageFor } from '@/lib/errors';
import { formatEventDateLong, formatPrice, formatRelative } from '@/lib/format';
import { ticketStatusLabel } from '@/lib/labels';
import {
  Badge, Body, Button, Caption, Divider, ErrorState, Input, LoadingState, Notice, Screen,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * The ticket itself. The QR encodes the ticket code plus its server-side secret;
 * scanning it calls check_in_ticket(), which verifies the secret, that the
 * scanner runs the event, and that the ticket has not already been used.
 */
export default function TicketScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();

  const [editingEmail, setEditingEmail] = useState(false);
  const [emailDraft, setEmailDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['ticket', id],
    queryFn: () => getTicket(id!),
    enabled: Boolean(id),
  });

  const defaultEmail = useQuery({ queryKey: ['ticket-email'], queryFn: getTicketEmail });

  const delivery = useQuery({
    queryKey: ['ticket-email-status', data?.order_id],
    queryFn: () => getTicketEmailStatus(data!.order_id!),
    enabled: Boolean(data?.order_id),
  });

  const sendAgain = async (address?: string | null) => {
    if (!data?.order_id) return;
    setSendError(null);
    setSending(true);
    try {
      const result = await resendTicketEmail(data.order_id, address);
      setSentTo(result.to_email);
      setEditingEmail(false);
      await queryClient.invalidateQueries({ queryKey: ['ticket-email-status', data.order_id] });
    } catch (caught) {
      setSendError(messageFor(caught));
    } finally {
      setSending(false);
    }
  };

  if (isLoading) return <Screen><LoadingState /></Screen>;

  if (isError || !data) {
    return (
      <Screen>
        <ErrorState
          message={error ? messageFor(error) : 'Túto vstupenku sa nepodarilo nájsť.'}
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

        {/* Where to sit. Printed above the QR rather than in the details below,
            because it is the thing the holder looks for while walking in — the
            code is for the person scanning it, not for them. */}
        {data.seat ? (
          <View style={styles.seatBox}>
            <Text style={styles.seatLine}>
              {[data.seat.venue_section?.name, `rad ${data.seat.row_label}`,
                `miesto ${data.seat.seat_number}`].filter(Boolean).join(' · ')}
            </Text>
            {data.seat.kind !== 'standard' || data.seat.note ? (
              <Caption>
                {[SEAT_KIND_LABEL[data.seat.kind as SeatKind], data.seat.note]
                  .filter(Boolean).join(' · ')}
              </Caption>
            ) : null}
          </View>
        ) : null}

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
                  ? 'Už bola použitá pri vstupe'
                  : data.status === 'refunded'
                    ? 'Peniaze boli vrátené'
                    : 'Zrušená'}
              </Body>
            </View>
          )}
        </View>

        <Text style={styles.code}>{data.code}</Text>
        <Badge tone={isUsable ? 'success' : 'neutral'} label={ticketStatusLabel[data.status].toUpperCase()} />
      </View>

      {data.checked_in_at ? (
        <Notice
          tone="accent"
          title="Na mieste"
          body={`Naskenovaná pri vstupe ${formatRelative(data.checked_in_at)}.`}
        />
      ) : null}

      <Divider />

      <View style={styles.detailRow}>
        <Caption>Zaplatené</Caption>
        <Body>{formatPrice(data.price_cents, data.currency)}</Body>
      </View>
      <View style={styles.detailRow}>
        <Caption>Vydaná</Caption>
        <Body>{formatRelative(data.created_at)}</Body>
      </View>

      <Divider />

      {/* --- delivery by email --------------------------------------------- */}
      <View style={styles.emailBlock}>
        <Caption>Vstupenka e-mailom</Caption>

        {sendError ? <Notice tone="danger" title="Neodoslané" body={sendError} /> : null}

        {sentTo ? (
          <Notice
            tone="success"
            title="Posielame"
            body={`Vstupenka ide na ${sentTo}. Ak nepríde do pár minút, pozri sa aj do spamu.`}
          />
        ) : delivery.data?.status === 'sent' ? (
          <Body muted>
            Poslaná na {delivery.data.to_email}
            {delivery.data.sent_at ? ` · ${formatRelative(delivery.data.sent_at)}` : ''}
          </Body>
        ) : delivery.data?.status === 'skipped' ? (
          <Body muted>
            Odosielanie e-mailov zatiaľ nie je nastavené. Vstupenku máš tu v aplikácii a platí
            rovnako.
          </Body>
        ) : delivery.data ? (
          <Body muted>Vstupenka je vo fronte na odoslanie na {delivery.data.to_email}.</Body>
        ) : (
          <Body muted>
            {defaultEmail.data
              ? `Pošleme ju na ${defaultEmail.data} ako PDF s QR kódom.`
              : 'K účtu nemáme e-mail, tak zadaj, kam ju máme poslať.'}
          </Body>
        )}

        {editingEmail ? (
          <>
            <Input
              value={emailDraft}
              onChangeText={setEmailDraft}
              placeholder="meno@example.com"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
            />
            <Button
              title="Poslať sem"
              loading={sending}
              disabled={!emailDraft.includes('@')}
              onPress={() => void sendAgain(emailDraft)}
            />
            <Button title="Zrušiť" variant="ghost" onPress={() => setEditingEmail(false)} />
          </>
        ) : (
          <>
            <Button
              title={delivery.data?.status === 'sent' ? 'Poslať znova' : 'Poslať na e-mail'}
              variant="secondary"
              loading={sending}
              disabled={!data.order_id || !defaultEmail.data}
              onPress={() => void sendAgain(null)}
            />
            <Button
              title="Iná adresa"
              variant="ghost"
              onPress={() => {
                setEmailDraft(defaultEmail.data ?? '');
                setEditingEmail(true);
              }}
            />
          </>
        )}
      </View>

      <Caption style={styles.footnote}>
        Túto obrazovku ukáž pri vstupe — alebo QR z PDF, ktoré ti príde e-mailom. Kód sa overuje na
        serveroch BLUPu, takže screenshot cudzej vstupenky nikoho dnu nedostane.
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

  seatBox: {
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
  },
  seatLine: { ...typography.subheading, color: colors.text, textAlign: 'center' },

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
  emailBlock: { gap: spacing.sm, marginTop: spacing.md },
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
