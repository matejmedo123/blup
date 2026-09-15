import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollViewProps } from 'react-native';

import { colors, spacing, typography } from '@/theme';

export interface PullToRefresh {
  handlers: Partial<ScrollViewProps>;
  indicator: React.ReactNode;
}

/** How far down before it fires, and how far the indicator is allowed to move. */
const TRIGGER = 72;
const MAX_PULL = 110;
/** Fingers move sideways too; past this angle it is a scroll, not a pull. */
const SLOP = 12;

/**
 * Pull down to reload, on the web.
 *
 * `RefreshControl` renders nothing on react-native-web, so a browser had no
 * refresh gesture at all — least of all a phone browser, which is exactly where
 * people reach for one.
 *
 * Only starts when the scroller is already at the top, so it can never fight
 * with an ordinary scroll, and only for touch: a mouse has a reload button.
 */
export function usePullToRefresh(
  onRefresh?: () => void | Promise<unknown>,
  refreshing = false,
): PullToRefresh {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);

  const atTop = useRef(true);
  const start = useRef<{ x: number; y: number } | null>(null);
  const armed = useRef(false);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    atTop.current = e.nativeEvent.contentOffset.y <= 0;
  }, []);

  const onTouchStart = useCallback((e: { nativeEvent: { touches: { pageX: number; pageY: number }[] } }) => {
    const touch = e.nativeEvent.touches?.[0];
    // Two fingers is a pinch, not a pull.
    if (!touch || e.nativeEvent.touches.length > 1 || !atTop.current || busy || refreshing) {
      start.current = null;
      return;
    }
    start.current = { x: touch.pageX, y: touch.pageY };
    armed.current = false;
  }, [busy, refreshing]);

  const onTouchMove = useCallback((e: { nativeEvent: { touches: { pageX: number; pageY: number }[] } }) => {
    const began = start.current;
    const touch = e.nativeEvent.touches?.[0];
    if (!began || !touch) return;

    const dy = touch.pageY - began.y;
    const dx = Math.abs(touch.pageX - began.x);

    if (!armed.current) {
      if (dy <= SLOP) {
        // Moving up or sideways: this was never a pull.
        if (dy < -SLOP || dx > SLOP) start.current = null;
        return;
      }
      armed.current = true;
    }

    // Resists as it goes, so it feels like pulling against something.
    setPull(Math.min(MAX_PULL, dy * 0.55));
  }, []);

  const finish = useCallback(async () => {
    const reached = pull >= TRIGGER;
    start.current = null;
    armed.current = false;

    if (!reached || !onRefresh) {
      setPull(0);
      return;
    }

    setBusy(true);
    setPull(TRIGGER);
    try {
      await onRefresh();
    } finally {
      setBusy(false);
      setPull(0);
    }
  }, [pull, onRefresh]);

  const active = busy || refreshing;
  const ready = pull >= TRIGGER;

  const indicator = pull > 0 || active ? (
    <View style={[styles.wrap, { height: active ? TRIGGER : pull }]} pointerEvents="none">
      {active ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <Text style={[styles.label, ready && styles.labelReady]}>
          {ready ? 'Pusti a obnoví sa' : 'Potiahni nadol'}
        </Text>
      )}
    </View>
  ) : null;

  return {
    handlers: {
      onScroll,
      scrollEventThrottle: 16,
      onTouchStart,
      onTouchMove,
      onTouchEnd: finish,
      onTouchCancel: finish,
    } as Partial<ScrollViewProps>,
    indicator,
  };
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginBottom: spacing.xs,
  },
  label: { ...typography.metaSm, color: colors.textTertiary },
  labelReady: { color: colors.accent },
});
