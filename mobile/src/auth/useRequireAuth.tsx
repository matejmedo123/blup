import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import { useAuth } from '@/auth/AuthProvider';
import { BottomSheet } from '@/components/BottomSheet';
import { Body, Button } from '@/components/ui';
import { colors, spacing, typography } from '@/theme';

/**
 * The gate between browsing and doing.
 *
 * A visitor can look at everything. The moment they try to *do* something —
 * say they are going, buy a ticket, write a message, save an event — this asks
 * them to sign in, says plainly what it is for, and sends them back to what
 * they were doing afterwards.
 *
 * A sheet rather than a redirect: bouncing somebody to a login page loses the
 * event they were looking at, and the reason they wanted an account in the
 * first place.
 */

/**
 * A way forward that needs no account.
 *
 * Buying a ticket is the one thing here that genuinely does not need one — a
 * name, an address and a town is all a ticket needs — so on that path the sheet
 * offers a third button instead of a wall. Without this the basket asked for an
 * account, and the checkout screen that knows how to sell to a guest was behind
 * it, unreachable.
 */
export interface GuestWay {
  /** Where "continue as guest" goes. */
  href: string;
  label?: string;
  /** Replaces the sheet's explanation, which otherwise says an account is required. */
  note?: string;
}

interface Gate {
  /**
   * Runs `action` when signed in; otherwise asks for an account and explains
   * why. Returns true when the action ran.
   *
   * `guest` adds the third option for paths that work without an account.
   */
  requireAuth: (reason: string, action: () => void, guest?: GuestWay | null) => boolean;
}

const GateContext = createContext<Gate | undefined>(undefined);

export function AuthGateProvider({ children }: { children: React.ReactNode }) {
  const { isGuest } = useAuth();
  const [reason, setReason] = useState<string | null>(null);
  const [guestWay, setGuestWay] = useState<GuestWay | null>(null);

  const requireAuth = useCallback(
    (why: string, action: () => void, guest?: GuestWay | null) => {
      if (isGuest) {
        setReason(why);
        setGuestWay(guest ?? null);
        return false;
      }
      action();
      return true;
    },
    [isGuest],
  );

  const close = useCallback(() => {
    setReason(null);
    setGuestWay(null);
  }, []);

  const value = useMemo(() => ({ requireAuth }), [requireAuth]);

  return (
    <GateContext.Provider value={value}>
      {children}

      <BottomSheet
        visible={reason !== null}
        onClose={close}
        title={guestWay ? 'Ako chceš pokračovať?' : 'Potrebuješ účet'}
      >
        <View style={styles.body}>
          <Text style={styles.lead}>{reason}</Text>
          <Body muted>
            {guestWay?.note
              ?? 'Účet je zadarmo a trvá minútu. Prezerať môžeš aj bez neho — bez účtu sa len nedá '
                 + 'kupovať, písať a prihlasovať sa na eventy.'}
          </Body>

          {/* First, because it is the fastest way to what they came for. The
              account is still one tap away and keeps the ticket afterwards. */}
          {guestWay ? (
            <Button
              title={guestWay.label ?? 'Pokračovať ako hosť'}
              onPress={() => {
                const href = guestWay.href;
                close();
                router.push(href);
              }}
            />
          ) : null}

          <Button
            title="Vytvoriť účet"
            variant={guestWay ? 'secondary' : 'primary'}
            onPress={() => {
              close();
              router.push('/(auth)/sign-up');
            }}
          />
          <Button
            title="Už mám účet"
            variant={guestWay ? 'ghost' : 'secondary'}
            onPress={() => {
              close();
              router.push('/(auth)/sign-in');
            }}
          />
        </View>
      </BottomSheet>
    </GateContext.Provider>
  );
}

export function useRequireAuth(): Gate {
  const context = useContext(GateContext);
  // Usable outside the provider (tests, isolated screens): without the gate the
  // action simply runs, which is the behaviour a signed-in app already has.
  return context ?? { requireAuth: (_reason, action) => { action(); return true; } };
}

const styles = StyleSheet.create({
  body: { gap: spacing.md, paddingBottom: spacing.lg },
  lead: { ...typography.bodyStrong, color: colors.text },
});
