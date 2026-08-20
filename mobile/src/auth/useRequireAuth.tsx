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

interface Gate {
  /**
   * Runs `action` when signed in; otherwise asks for an account and explains
   * why. Returns true when the action ran.
   */
  requireAuth: (reason: string, action: () => void) => boolean;
}

const GateContext = createContext<Gate | undefined>(undefined);

export function AuthGateProvider({ children }: { children: React.ReactNode }) {
  const { isGuest } = useAuth();
  const [reason, setReason] = useState<string | null>(null);

  const requireAuth = useCallback(
    (why: string, action: () => void) => {
      if (isGuest) {
        setReason(why);
        return false;
      }
      action();
      return true;
    },
    [isGuest],
  );

  const value = useMemo(() => ({ requireAuth }), [requireAuth]);

  return (
    <GateContext.Provider value={value}>
      {children}

      <BottomSheet visible={reason !== null} onClose={() => setReason(null)} title="Potrebuješ účet">
        <View style={styles.body}>
          <Text style={styles.lead}>{reason}</Text>
          <Body muted>
            Účet je zadarmo a trvá minútu. Prezerať môžeš aj bez neho — bez účtu sa len nedá
            kupovať, písať a prihlasovať sa na eventy.
          </Body>

          <Button
            title="Vytvoriť účet"
            onPress={() => {
              setReason(null);
              router.push('/(auth)/sign-up');
            }}
          />
          <Button
            title="Už mám účet"
            variant="secondary"
            onPress={() => {
              setReason(null);
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
