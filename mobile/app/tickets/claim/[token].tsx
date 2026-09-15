import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import { claimTicketsWithToken } from '@/api/tickets';
import { messageFor } from '@/lib/errors';
import { Body, Button, EmptyState, LoadingState, Notice, Screen } from '@/components/ui';
import { spacing } from '@/theme';

/**
 * The link from a guest ticket e-mail.
 *
 * The ticket already works without any of this — the QR in the inbox is what
 * gets somebody through the door. This page exists for the person who would
 * rather have it in the app, and it is the only path for somebody who signed up
 * with a different address than the one the organizer sent it to.
 */
export default function ClaimTicketScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const { isGuest } = useAuth();
  const queryClient = useQueryClient();

  // Starts where it is actually going: with a token and a signed-in viewer the
  // work begins immediately, so rendering "idle" first only to correct it is a
  // render nobody needed.
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'failed'>(
    () => (token && !isGuest ? 'working' : 'idle'),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);

  useEffect(() => {
    // Signing in is the one prerequisite: the ticket has to end up attached to
    // somebody. The token survives the round trip through the sign-in screen.
    if (!token || isGuest || state !== 'working') return;

    void (async () => {
      try {
        const result = await claimTicketsWithToken(token);
        setEventId(result.event_id);

        if (result.ok && result.reason === 'ALREADY_YOURS') {
          setMessage('Túto vstupenku už máš v Blupe.');
        } else if (result.ok) {
          setMessage(
            result.tickets === 1
              ? 'Vstupenka je tvoja — nájdeš ju v sekcii Vstupenky.'
              : `Vstupenky sú tvoje (${result.tickets}) — nájdeš ich v sekcii Vstupenky.`,
          );
        } else {
          setMessage('Tento odkaz už niekto použil. Ak si to nebol ty, ozvi sa organizátorovi.');
          setState('failed');
          return;
        }

        await queryClient.invalidateQueries({ queryKey: ['tickets'] });
        setState('done');
      } catch (caught) {
        setMessage(messageFor(caught));
        setState('failed');
      }
    })();
  }, [token, isGuest, state, queryClient]);

  if (isGuest) {
    return (
      <Screen>
        <EmptyState
          emoji="🎟"
          title="Prihlás sa a vstupenka bude tvoja"
          body={
            'Na vstup ti stačí QR kód z e-mailu — účet na to nepotrebuješ. '
            + 'Ak ju chceš mať aj v aplikácii, prihlás sa a vrátime ťa sem.'
          }
          actionLabel="Prihlásiť sa"
          onAction={() => router.push(`/(auth)/sign-in?next=/tickets/claim/${token}`)}
        />
      </Screen>
    );
  }

  if (state === 'working' || state === 'idle') {
    return <Screen><LoadingState /></Screen>;
  }

  return (
    <Screen>
      <View style={{ gap: spacing.md, padding: spacing.lg }}>
        {state === 'done' ? (
          <Notice tone="success" title="Hotovo" body={message ?? ''} />
        ) : (
          <Notice tone="danger" title="Nepodarilo sa" body={message ?? ''} />
        )}

        <Body muted>
          QR kód v e-maili platí tak či tak — aj keby sa tu niečo pokazilo, pri
          vstupe ťa pustí.
        </Body>

        <Button title="Moje vstupenky" onPress={() => router.replace('/tickets')} />
        {eventId ? (
          <Button
            title="Pozrieť event"
            variant="secondary"
            onPress={() => router.replace(`/event/${eventId}`)}
          />
        ) : null}
      </View>
    </Screen>
  );
}
