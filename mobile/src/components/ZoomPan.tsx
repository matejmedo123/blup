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
export interface ZoomPanView { scale: number; x: number; y: number }

export interface ZoomPanHandle {
  reset: () => void;
  zoomBy: (factor: number) => void;
  /**
   * Put a point of the drawing in the middle of the frame at a given zoom.
   *
   * Used to go to a sector somebody tapped, rather than opening it in a view
   * of its own: the stand fills the screen but its neighbours are still there,
   * one drag away, which is how a plan of a hall is read.
   */
  focus: (point: { x: number; y: number }, scale: number) => void;
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
  /** The whole transform, plus the frame it is inside — for deciding what is on screen. */
  onViewChange?: (view: ZoomPanView, frame: { width: number; height: number }) => void;
}

export const ZoomPan = React.forwardRef<ZoomPanHandle, Props>(function ZoomPan({
  children, contentWidth, contentHeight,
  initialScale = 1, minScale = 1, maxScale = 6, style, onScaleChange, onViewChange,
}, ref) {
  const [frame, setFrame] = React.useState({ width: 0, height: 0 });
  const frameSizeRef = React.useRef(frame);
  frameSizeRef.current = frame;
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
    onViewChange?.(clamped, frameSizeRef.current);
  }, [clamp, onScaleChange, onViewChange]);

  React.useImperativeHandle(ref, () => ({
    reset: () => apply({ scale: initialScale, x: 0, y: 0 }),
    zoomBy: (factor: number) => apply({ ...live.current, scale: live.current.scale * factor }),
    // The offset that brings a point of the content to the centre: the content
    // is centred first, so a point at its middle needs no offset at all, and
    // one at the edge needs half the content's scaled size.
    focus: (point, scale) => apply({
      scale,
      x: (contentWidth / 2 - point.x) * scale,
      y: (contentHeight / 2 - point.y) * scale,
    }),
  }), [apply, initialScale, contentWidth, contentHeight]);

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

  /**
   * A mouse has no second finger, so the wheel is how a desktop zooms.
   *
   * Attached to the DOM node rather than passed as an `onWheel` prop, because
   * react-native-web forwards a fixed list of handlers to the element and
   * `onWheel` is not on it. Written as a prop it type-checks, renders, and
   * does nothing at all — the plan would have been pannable on a desktop and
   * not zoomable, which is exactly the kind of failure that ships.
   *
   * `passive: false` so preventDefault actually applies: a passive wheel
   * listener cannot stop the page scrolling underneath.
   */
  const frameRef = React.useRef<View>(null);

  React.useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const node = frameRef.current as unknown as HTMLElement | null;
    if (!node?.addEventListener) return undefined;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      apply({ ...live.current, scale: live.current.scale * (event.deltaY > 0 ? 0.92 : 1.08) });
    };

    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [apply]);

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setFrame({ width, height });
  };

  return (
    <View
      ref={frameRef}
      style={[styles.frame, style]}
      onLayout={onLayout}
      nativeID="blup-plan-surface"
      {...responder.panHandlers}
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
