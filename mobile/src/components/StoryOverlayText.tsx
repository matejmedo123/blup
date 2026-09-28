import React, { useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import {
  clampSpot, overlayType, overlayWidthAt,
  type OverlaySpot, type OverlayTextSize,
} from '@/components/storyOverlayMath';
import { colors, typography } from '@/theme';

/**
 * Text cez príbeh — jeden komponent pre editor, kameru aj prehrávač.
 *
 * Že je jeden, je celá pointa. Predtým ho kreslili tri obrazovky vlastným
 * kódom a rozchádzali sa: editor mal text na 42 % výšky, ukladal 50 % a
 * prehrávač kreslil 50 %. Človek ho dal jednam a objavil sa inde.
 *
 * Text sa nevypaľuje do obrázka. Vypálený text sa nedá opraviť, nedá sa
 * prečítať čítačkou pre nevidiacich a pri videu by ho bolo treba prekódovať
 * do každého snímku. Kreslí sa nad médiom, takže funguje rovnako nad fotkou
 * aj nad bežiacim videom.
 *
 * Tieň nie je ozdoba: biely text na fotke je dosť často nečitateľný a je to
 * práve tieň, čo dovolí, aby ktorákoľvek z piatich farieb sedela na
 * ktoromkoľvek obrázku.
 */
export const OVERLAY_COLORS = {
  white:  '#FFFFFF',
  black:  '#0A0D12',
  accent: colors.accent,
  pink:   colors.pink,
  amber:  '#FBBF24',
} as const;

export type OverlayColor = keyof typeof OVERLAY_COLORS;

export function StoryOverlayText({
  text, spot, color, size, frame, dim,
}: {
  text: string;
  spot?: Partial<OverlaySpot> | null;
  color?: OverlayColor;
  size?: OverlayTextSize;
  /** Rámček, v ktorom text leží. Poloha aj písmo sú jeho zlomky. */
  frame: { width: number; height: number };
  /** Editor si takto označí vrstvu, ktorú práve ťaháš. */
  dim?: boolean;
}) {
  /**
   * Výška textu sa musí ODMERAŤ, aby sa dal vycentrovať na svoju polohu.
   *
   * `y` je stred textu, nie jeho horná hrana — inak by dvojriadkový text
   * sedel inde než jednoriadkový na tom istom mieste. Percentuálny posun v
   * `transform` by to vyriešil bez merania, ale na webe aj na telefóne sa
   * správa rôzne, a rozdiel medzi editorom a prehrávačom je presne to, čomu
   * sa tu vyhýbame.
   */
  const [height, setHeight] = useState(0);
  const onLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.height;
    setHeight((current) => (Math.abs(current - next) < 0.5 ? current : next));
  };

  const body = text.trim();
  if (!body) return null;

  const at = clampSpot(spot);
  const width = overlayWidthAt(at.x);
  const type = overlayType(size, frame.width);

  return (
    <View
      onLayout={onLayout}
      pointerEvents="none"
      style={[
        styles.wrap,
        {
          width: frame.width * width,
          left: frame.width * (at.x - width / 2),
          top: frame.height * at.y - height / 2,
          opacity: dim ? 0.55 : 1,
        },
      ]}
    >
      <Text
        style={[
          styles.text,
          type,
          { color: OVERLAY_COLORS[color ?? 'white'] ?? OVERLAY_COLORS.white },
          // Čierny text potrebuje svetlý tieň, aby prežil tmavú fotku;
          // každá iná farba tmavý.
          color === 'black' && styles.onLight,
        ]}
      >
        {body}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute' },
  text: {
    ...typography.subheading,
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 6,
  },
  onLight: { textShadowColor: 'rgba(255,255,255,0.65)' },
});
