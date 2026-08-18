import React from 'react';
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Path, Defs, LinearGradient, Stop } from 'react-native-svg';

import { colors } from '@/theme';

/**
 * The BLUP mark.
 *
 * The concept document specifies "logo: bublina, notifikačný vlnovec, lokátor"
 * — a speech bubble that is also a map pin, with a signal wave coming off it.
 * Drawn as SVG rather than shipped as a PNG so it stays crisp at every size and
 * can take the accent colour from the theme.
 */
export function BlupMark({
  size = 40,
  style,
  monochrome = false,
}: {
  size?: number;
  style?: StyleProp<ViewStyle>;
  monochrome?: boolean;
}) {
  const start = monochrome ? colors.text : '#2B6BFF';
  const end = monochrome ? colors.text : '#4FD1C5';

  return (
    <View style={style}>
      <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
        <Defs>
          <LinearGradient id="blupMark" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={start} />
            <Stop offset="1" stopColor={end} />
          </LinearGradient>
        </Defs>

        {/* The bubble, with the pin's tail dropping from its lower left — one
            shape that reads as both a chat bubble and a map marker. */}
        <Path
          d="M32 6c12.7 0 23 8.9 23 19.9 0 11-10.3 19.9-23 19.9-2.2 0-4.4-.3-6.4-.8l-11.8 8.4a1.6 1.6 0 0 1-2.5-1.6l2.4-10.7C7.4 37.7 9 31.9 9 25.9 9 14.9 19.3 6 32 6Z"
          fill="url(#blupMark)"
        />

        {/* The locator dot inside it. */}
        <Circle cx="32" cy="25" r="6.5" fill={colors.background} />

        {/* The notification wave. */}
        <Path
          d="M45.5 14.5c3.2 2.9 5 6.7 5 10.7s-1.8 7.8-5 10.7"
          stroke="url(#blupMark)"
          strokeWidth={3.2}
          strokeLinecap="round"
          opacity={0.55}
        />
      </Svg>
    </View>
  );
}

/** The mark and the wordmark side by side, for headers and the splash. */
export function BlupLockup({ size = 34 }: { size?: number }) {
  return (
    <View style={styles.row}>
      <BlupMark size={size * 1.15} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
