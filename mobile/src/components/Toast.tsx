import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { colors, radius, shadow, spacing, typography } from '@/theme';

/**
 * The toast from the handoff: a white pill 18px from the sides, 104px from the
 * bottom, that rises in and disappears after 2.2s.
 *
 * Every confirmation in the app goes through this — "Blupnuté, uložené do Ja",
 * "Ideš! Pridali sme ťa do crew" — so the wording lives at the call site and
 * the presentation lives here.
 */

const DURATION = 2200;

interface ToastContextValue {
  show: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue>({ show: () => undefined });

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((next: string) => {
    setMessage(next);
  }, []);

  useEffect(() => {
    if (!message) return;

    // blupRise: translateY(14) + fade, 0.24s ease-out.
    Animated.timing(progress, {
      toValue: 1,
      duration: 240,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      Animated.timing(progress, {
        toValue: 0,
        duration: 180,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setMessage(null);
      });
    }, DURATION);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [message, progress]);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}

      {message ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.wrapper,
            {
              opacity: progress,
              transform: [
                { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) },
              ],
            },
          ]}
        >
          <View style={styles.pill}>
            <Text style={styles.text} numberOfLines={2}>{message}</Text>
          </View>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: spacing.gutter,
    right: spacing.gutter,
    bottom: 104,
    alignItems: 'center',
  },
  pill: {
    backgroundColor: colors.text,
    borderRadius: radius.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: 13,
    maxWidth: '100%',
    ...shadow.toast,
  },
  text: { ...typography.bodyStrong, color: colors.page, textAlign: 'center' },
});
