import React from 'react';
import {
  PanResponder, Platform, StyleSheet, View,
  type LayoutChangeEvent, type StyleProp, type ViewStyle,
} from 'react-native';

/**
 * A surface you move around: drag to pan, pinch to zoom, wheel to zoom on a
 * desktop.
 *
 * Built for the seat plan. A stand with four hundred seats cannot be drawn at
 * a size a thumb can hit AND fit on a phone at once, and the answer used to be
 * to give up on the plan: pick a row from a list of chips, then a seat from a
 * strip of numbers. That works, but it is not a plan — you cannot see where
 * you will be sitting, which is the entire reason for showing one.
 *
 * So the plan stays a plan and the screen moves instead.
 *
 * Deliberately PanResponder rather than react-native-gesture-handler: this has
 * to behave identically in a browser and on a phone, and the two-finger case is
 * simple enough (distance between the touches) that the extra dependency buys
 * nothing. `onMoveShouldSetPanResponder` only claims the gesture once a finger
 * has actually travelled, so a tap still reaches the seat underneath.
 */
export interface ZoomPanHandle {
  reset: () => void;
  zoomBy: (factor: number) => void;
}

interface Props {
  children: React.ReactNode;
  /** The drawing's own size, in points, before any zoom. */
  contentWidth: number;
  contentHeight: number;
  /** Where to start. 1 = fits the frame. */
  initialScale?: number;
  minScale?: number;
  maxScale?: number;
  style?: StyleProp<ViewStyle>;
  onScaleChange?: (scale: number) => void;
}

export const ZoomPan = React.forwardRef<ZoomPanHandle, Props>(function ZoomPan({
  children, contentWidth, contentHeight,
  initialScale = 1, minScale = 1, maxScale = 6, style, onScaleChange,
}, ref) {
  const [frame, setFrame] = React.useState({ width: 0, height: 0 });
  const [view, setView] = React.useState({ scale: initialScale, x: 0, y: 0 });

  // The gesture reads and writes these directly. State alone would lag a finger
  // by a frame and make the drag feel like it is on elastic.
  const live = React.useRef(view);
  const start = React.useRef({ scale: 1, x: 0, y: 0, distance: 0 });

  const clamp = React.useCallback((next: { scale: number; x: number; y: number }) => {
    const scale = Math.min(maxScale, Math.max(minScale, next.scale));
    // Never let the drawing be dragged off the frame: the most it can move is
    // the part that does not fit. At scale 1 that is zero, so it cannot move
    // at all, which is what "it fits" should feel like.
    const slackX = Math.max(0, (contentWidth * scale - frame.width) / 2);
    const slackY = Math.max(0, (contentHeight * scale - frame.height) / 2);
    return {
      scale,
      x: Math.min(slackX, Math.max(-slackX, next.x)),
      y: Math.min(slackY, Math.max(-slackY, next.y)),
    };
  }, [contentWidth, contentHeight, frame.width, frame.height, minScale, maxScale]);

  const apply = React.useCallback((next: { scale: number; x: number; y: number }) => {
    const clamped = clamp(next);
    live.current = clamped;
    setView(clamped);
    onScaleChange?.(clamped.scale);
  }, [clamp, onScaleChange]);

  React.useImperativeHandle(ref, () => ({
    reset: () => apply({ scale: initialScale, x: 0, y: 0 }),
    zoomBy: (factor: number) => apply({ ...live.current, scale: live.current.scale * factor }),
  }), [apply, initialScale]);

  const responder = React.useMemo(() => PanResponder.create({
    // Not on start: a press must be allowed to reach the seat under it. The
    // gesture is claimed only once a finger has moved far enough that it is
    // clearly a drag and not a tap.
    onMoveShouldSetPanResponder: (_event, gesture) => (
      Math.abs(gesture.dx) > 4 || Math.abs(gesture.dy) > 4 || gesture.numberActiveTouches > 1
    ),
    onPanResponderGrant: (event) => {
      const touches = event.nativeEvent.touches;
      start.current = {
        ...live.current,
        distance: touches.length > 1 ? touchDistance(touches) : 0,
      };
    },
    onPanResponderMove: (event, gesture) => {
      const touches = event.nativeEvent.touches;

      if (touches.length > 1) {
        const distance = touchDistance(touches);
        if (start.current.distance === 0) {
          start.current = { ...live.current, distance };
          return;
        }
        apply({
          ...live.current,
          scale: start.current.scale * (distance / start.current.distance),
        });
        return;
      }

      apply({
        scale: live.current.scale,
        x: start.current.x + gesture.dx,
        y: start.current.y + gesture.dy,
      });
    },
    onPanResponderRelease: () => { start.current = { ...live.current, distance: 0 }; },
    onPanResponderTerminationRequest: () => false,
  }), [apply]);

  // A mouse has no second finger. Wheel is what a desktop reaches for, and
  // without it the plan is only pannable there.
  const wheel = Platform.OS === 'web'
    ? {
      onWheel: (event: { deltaY: number; preventDefault?: () => void }) => {
        event.preventDefault?.();
        apply({ ...live.current, scale: live.current.scale * (event.deltaY > 0 ? 0.92 : 1.08) });
      },
    }
    : {};

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setFrame({ width, height });
  };

  return (
    <View
      style={[styles.frame, style]}
      onLayout={onLayout}
      nativeID="blup-plan-surface"
      {...responder.panHandlers}
      {...(wheel as object)}
    >
      <View
        style={{
          width: contentWidth,
          height: contentHeight,
          transform: [
            { translateX: view.x },
            { translateY: view.y },
            { scale: view.scale },
          ],
        }}
      >
        {children}
      </View>
    </View>
  );
});

function touchDistance(touches: { pageX: number; pageY: number }[]): number {
  const [a, b] = touches;
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

const styles = StyleSheet.create({
  frame: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
