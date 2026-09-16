import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { ScrollViewProps } from 'react-native';

import { PULL_TRIGGER, pullReleased, pullStep } from './pullMath';
import { colors, spacing, typography } from '@/theme';

export interface PullToRefresh {
  handlers: Partial<ScrollViewProps>;
  indicator: React.ReactNode;
}

/**
 * Pull down to reload, on the web.
 *
 * `RefreshControl` renders nothing on react-native-web, so a browser had no
 * refresh gesture at all — least of all a phone browser, which is exactly where
 * people reach for one.
 *
 * The listeners are on the document rather than on the ScrollView's props. The
 * first version went through react-native-web's responder props and did not
 * work on a phone; which of the several possible reasons it was did not matter
 * as much as not depending on any of them. Here the gesture is read from the
 * DOM, and whether it is allowed to start is decided by the real scrolling
 * element under the finger — which may be an inner div or the page itself,
 * depending on the screen.
 */
export function usePullToRefresh(
  onRefresh?: () => void | Promise<unknown>,
  refreshing = false,
): PullToRefresh {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);

  // In refs, not state: these change on every touchmove and must not re-render.
  const start = useRef<{ x: number; y: number } | null>(null);
  const armed = useRef(false);
  const distance = useRef(0);
  const enabled = useRef(false);

  // The latest callback, and whether a refresh is already running, kept where
  // the listeners can read them at the moment a finger moves.
  //
  // Written in an effect rather than during render on purpose: writing a ref
  // while rendering is what React Compiler forbids, and it would be wrong under
  // concurrent rendering, where a render can be thrown away. The listeners only
  // ever read these after the screen is on-screen, so a commit is early enough.
  const onRefreshRef = useRef(onRefresh);
  const blocked = useRef(false);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
    blocked.current = busy || refreshing;
  });

  /** The thing that actually scrolls under this point, and whether it is at 0. */
  const scrollerAtTop = useCallback((target: EventTarget | null): boolean => {
    let node = target as HTMLElement | null;
    while (node && node !== document.body) {
      const style = globalThis.getComputedStyle?.(node);
      const scrolls = style
        && (style.overflowY === 'auto' || style.overflowY === 'scroll')
        && node.scrollHeight > node.clientHeight + 1;
      if (scrolls) return node.scrollTop <= 0;
      node = node.parentElement;
    }
    // Nothing inner scrolls: the page itself is the scroller.
    return (globalThis.scrollY ?? 0) <= 0;
  }, []);

  // Attached once, for the life of the screen.
  //
  // It used to depend on `onRefresh`, which callers write inline — a new
  // function every render, so the listeners were torn down and rebuilt on each
  // one. Measured at over seven hundred times before a finger even touched the
  // screen, and a touchmove arriving mid-rebuild landed on nothing. The
  // callback is read from a ref at the moment it is needed instead.
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const onStart = (e: TouchEvent) => {
      if (!onRefreshRef.current || blocked.current || e.touches.length !== 1) {
        start.current = null;
        return;
      }
      const touch = e.touches[0];
      enabled.current = scrollerAtTop(e.target);
      start.current = { x: touch.pageX, y: touch.pageY };
      armed.current = false;
      distance.current = 0;
    };

    const onMove = (e: TouchEvent) => {
      const began = start.current;
      if (!began || e.touches.length !== 1) return;

      const touch = e.touches[0];
      const step = pullStep({
        atTop: enabled.current,
        dx: touch.pageX - began.x,
        dy: touch.pageY - began.y,
        armed: armed.current,
      });

      if (step.abandoned) {
        start.current = null;
        armed.current = false;
        if (distance.current !== 0) { distance.current = 0; setPull(0); }
        return;
      }

      armed.current = step.armed;
      if (step.distance !== distance.current) {
        distance.current = step.distance;
        setPull(step.distance);
      }
    };

    const onEnd = () => {
      const reached = pullReleased(distance.current);
      start.current = null;
      armed.current = false;
      distance.current = 0;

      if (!reached) { setPull(0); return; }

      setBusy(true);
      setPull(PULL_TRIGGER);
      void (async () => {
        try {
          await onRefreshRef.current?.();
        } finally {
          setBusy(false);
          setPull(0);
        }
      })();
    };

    // Passive: the gesture is only ever read, never cancelled, so the browser's
    // own scrolling is never delayed waiting to find out.
    const opts = { passive: true } as AddEventListenerOptions;
    document.addEventListener('touchstart', onStart, opts);
    document.addEventListener('touchmove', onMove, opts);
    document.addEventListener('touchend', onEnd, opts);
    document.addEventListener('touchcancel', onEnd, opts);

    return () => {
      document.removeEventListener('touchstart', onStart, opts);
      document.removeEventListener('touchmove', onMove, opts);
      document.removeEventListener('touchend', onEnd, opts);
      document.removeEventListener('touchcancel', onEnd, opts);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = busy || refreshing;
  const ready = pull >= PULL_TRIGGER;

  const indicator = pull > 0 || active ? (
    <View style={[styles.wrap, { height: active ? PULL_TRIGGER : pull }]} pointerEvents="none">
      {active ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <Text style={[styles.label, ready && styles.labelReady]}>
          {ready ? 'Pusti a obnoví sa' : 'Potiahni nadol'}
        </Text>
      )}
    </View>
  ) : null;

  // Nothing to spread any more; kept so screens do not all have to change when
  // the implementation does.
  return { handlers: {}, indicator };
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
