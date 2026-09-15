import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { waitForCheckout, waitForTickets } from '@/api/tickets';
import { track } from '@/marketing/tags';
import { messageFor } from '@/lib/errors';
import { Body, Button, Caption, LoadingState, Notice, Screen } from '@/components/ui';
import { colors, spacing, typography } from '@/theme';

/**
 * Where Stripe sends the browser back to after a hosted Checkout.
 *
 * Landing here does not mean the money moved — Stripe redirects on its own
 * schedule and the webhook may still be in flight. So this screen does exactly
 * what the native flow does: waits for the ticket rows the webhook creates, and
 * says so plainly while it waits.
 *
 * Native never reaches this route; it is registered anyway so a link shared
 * from a browser opens somewhere sensible on a phone.
 */
export default function CheckoutReturnScreen() {
  // A single ticket comes back as ?order=…, a basket as ?checkout=…. Both wait
  // for the same thing: the webhook, which is still the only thing that turns
  // money into a ticket.
  const { order, checkout } = useLocalSearchParams<{ order?: string; checkout?: string }>();
  // Arriving with neither parameter is knowable from the first render; it does
  // not need an effect to discover it.
  const [state, setState] = useState<'waiting' | 'done' | 'pending' | 'failed'>(
    () => (order || checkout ? 'waiting' : 'pending'),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!order && !checkout) return;

    void (async () => {
      try {
        const result = checkout
          ? await waitForCheckout(checkout, { attempts: 20, intervalMs: 1200 })
          : await waitForTickets(order!, { attempts: 20, intervalMs: 1200 });
        if (cancelled) return;
        setState(result.status === 'succeeded' ? 'done' : result.status === 'failed' ? 'failed' : 'pending');

        // The conversion is reported once the *webhook* has issued the tickets,
        // not when Stripe redirected the browser here. A redirect is not a
        // payment, and a conversion counted on one is a number nobody can trust.
        if (result.status === 'succeeded') {
          track('purchase', {
            valueCents: result.tickets.reduce(
              (sum, ticket) => sum + (ticket.price_cents ?? 0), 0,
            ),
            currency: result.tickets[0]?.currency ?? 'EUR',
            items: result.tickets.map((ticket) => ({
              id: ticket.ticket_type_id ?? ticket.event_id,
              quantity: 1,
            })),
          });
        }
      } catch (caught) {
        if (cancelled) return;
        setError(messageFor(caught));
        setState('pending');
      }
    })();

    return () => { cancelled = true; };
  }, [order, checkout]);

  if (state === 'waiting') {
    return (
      <Screen>
        <LoadingState label="Potvrdzujem platbu s bankou…" />
        <Caption style={styles.hint}>
          Vstupenku vydáme, až keď platbu potvrdí banka. Toto je tá poctivá časť — trvá pár sekúnd.
          Stránku môžeš pokojne nechať otvorenú.
        </Caption>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <View style={styles.wrap}>
        {state === 'done' ? (
          <>
            <Text style={styles.emoji}>🎫</Text>
            <Text style={styles.title}>Si dnu</Text>
            <Body muted style={styles.body}>
              Vstupenka je potvrdená. Nájdeš ju tu aj v e-maile ako PDF s QR kódom — pri vstupe stačí
              ukázať ktorýkoľvek z nich.
            </Body>
            <Button title="Vstupenky" onPress={() => router.replace('/tickets')} />
          </>
        ) : state === 'failed' ? (
          <>
            <Text style={styles.emoji}>✕</Text>
            <Text style={styles.title}>Platba neprešla</Text>
            <Body muted style={styles.body}>
              Nič sme ti nestrhli. Skús to znova, prípadne inou kartou.
            </Body>
            <Button title="Späť na eventy" variant="secondary" onPress={() => router.replace('/')} />
          </>
        ) : (
          <>
            <Text style={styles.emoji}>⏳</Text>
            <Text style={styles.title}>Ešte to potvrdzujeme</Text>
            <Body muted style={styles.body}>
              Banka nám to zatiaľ nepotvrdila. Ak peniaze odišli, vstupenka sa objaví v sekcii
              Moje vstupenky a príde ti aj e-mailom — netreba platiť znova.
            </Body>
            {error ? <Notice tone="warning" title="Detail" body={error} /> : null}
            <Button title="Moje vstupenky" onPress={() => router.replace('/tickets')} />
          </>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: spacing.md, paddingTop: spacing.xxxl },
  emoji: { fontSize: 56 },
  title: { ...typography.title, color: colors.text, textAlign: 'center' },
  body: { textAlign: 'center', marginBottom: spacing.lg },
  hint: { textAlign: 'center', paddingHorizontal: spacing.xl, marginBottom: spacing.xxl },
});
