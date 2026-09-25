import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Modal, PanResponder, Platform, Pressable, StyleSheet, Text, TextInput, View,
  type LayoutChangeEvent,
} from 'react-native';
import { Image } from 'expo-image';

import { messageFor } from '@/lib/errors';
import { Button, Caption, Notice } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';
import { cropRect } from '@/components/imageCropMath';
import { cropToStory, storyFrame, STORY_WIDTH, STORY_HEIGHT } from '@/components/storyFormat';
import type { OverlayColor, OverlaySize, StoryDraft } from '@/components/StoryCamera';

/**
 * Úprava fotky z galérie, kým sa z nej stane príbeh.
 *
 * Príbeh má jeden rozmer, 1080 × 1920. Fotka z galérie ho skoro nikdy nemá —
 * býva na šírku, štvorcová, alebo na výšku ale v inom pomere. Doteraz sa
 * nahrala tak, ako bola, a prehrávač ju musel niekam vložiť; výsledkom boli
 * čierne pásy, ktoré vyzerali ako chyba.
 *
 * Tu si výrez volí človek, nie algoritmus: fotka sa ťahá a približuje v
 * rámčeku, ktorý má presne tvar príbehu, a čo je v rámčeku, to sa uloží. Nič
 * sa nedá vytiahnuť mimo — najmenšie priblíženie je presne to, pri ktorom
 * fotka rámček ešte celý vyplní, takže prázdny roh nemôže vzniknúť.
 */

const OVERLAY_COLORS: Record<OverlayColor, string> = {
  white:  '#FFFFFF',
  black:  '#0A0D12',
  accent: colors.accent,
  pink:   colors.pink,
  amber:  '#FBBF24',
};

const MAX_SCALE = 5;

export function StoryEditor({
  photo, onCancel, onDone,
}: {
  /** null zatvára. Rozmery musia prísť s fotkou — bez nich sa orezať nedá. */
  photo: { uri: string; width: number; height: number } | null;
  onCancel: () => void;
  onDone: (draft: StoryDraft) => void;
}) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [text, setText] = useState('');
  const [colour, setColour] = useState<OverlayColor>('white');
  const [size, setSize] = useState<OverlaySize>('m');
  const [writing, setWriting] = useState(false);

  const [stage, setStage] = useState({ width: 0, height: 0 });
  const onStageLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setStage((current) =>
      current.width === width && current.height === height ? current : { width, height });
  }, []);

  const frame = useMemo(() => storyFrame(stage.width, stage.height), [stage.width, stage.height]);

  // Kde fotka v rámčeku sedí. Počíta to `cropRect` — tá istá funkcia, ktorá
  // potom vyreže súbor, takže náhľad a výsledok nemôžu nesúhlasiť.
  const rect = cropRect({
    imageW: photo?.width || 1,
    imageH: photo?.height || 1,
    frameW: frame.width || 1,
    frameH: frame.height || 1,
    scale,
    offset,
  });

  // --- ťahanie a štipnutie ---------------------------------------------------
  //
  // PanResponder, nie gesture-handler: toto je jediné gesto na obrazovke a
  // funguje rovnako na telefóne aj v prehliadači, kde sa dvoma prstami
  // neštipká, ale ťahá myšou a približuje tlačidlami pod rámčekom.
  const start = useRef({ x: 0, y: 0, scale: 1, spread: 0 });
  const live = useRef({ scale: 1, offset: { x: 0, y: 0 } });
  live.current = { scale, offset: rect.view };

  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (event) => {
      const touches = event.nativeEvent.touches;
      start.current = {
        x: live.current.offset.x,
        y: live.current.offset.y,
        scale: live.current.scale,
        spread: touches.length >= 2 ? distance(touches) : 0,
      };
    },
    onPanResponderMove: (event, gesture) => {
      const touches = event.nativeEvent.touches;
      if (touches.length >= 2) {
        const spread = distance(touches);
        if (start.current.spread > 0 && spread > 0) {
          const next = start.current.scale * (spread / start.current.spread);
          setScale(Math.min(MAX_SCALE, Math.max(1, next)));
        }
        return;
      }
      // Jeden prst posúva. Hodnota sa neklampuje tu — robí to `cropRect`, a
      // robí to na jednom mieste pre kreslenie aj pre rezanie.
      setOffset({ x: start.current.x + gesture.dx, y: start.current.y + gesture.dy });
    },
    onPanResponderRelease: () => {
      // Uloží sa to, čo je naozaj vidno, nie to, kam prst zašiel za okraj.
      setOffset(live.current.offset);
      start.current.spread = 0;
    },
  }), []);

  const zoomBy = (factor: number) =>
    setScale((current) => Math.min(MAX_SCALE, Math.max(1, current * factor)));

  const send = async () => {
    if (!photo || busy) return;
    if (!frame.width || !frame.height) return;
    setBusy(true);
    setError(null);
    try {
      const uri = await cropToStory(photo.uri, {
        scale,
        offset: rect.view,
        frame,
        source: { width: photo.width, height: photo.height },
      });
      const written = text.trim();
      onDone({
        uri,
        kind: 'image',
        ...(written ? { overlay: { text: written, y: 0.5, color: colour, size } } : {}),
      });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const usable = Boolean(photo?.width && photo?.height);

  return (
    <Modal visible={Boolean(photo)} animationType="slide" onRequestClose={onCancel}>
      <View style={styles.screen}>
        <View style={styles.top}>
          <Pressable onPress={onCancel} hitSlop={12} accessibilityRole="button">
            <Text style={styles.close}>✕</Text>
          </Pressable>
          <Text style={styles.title}>Uprav príbeh</Text>
          <View style={styles.closeSpacer} />
        </View>

        {error ? <Notice tone="danger" title="Toto sa nepodarilo" body={error} /> : null}

        {!usable ? (
          <Caption style={styles.centre}>
            Túto fotku sa nepodarilo načítať — skús inú.
          </Caption>
        ) : (
          <View style={styles.stage} onLayout={onStageLayout}>
            <View style={[styles.frame, frame]} {...pan.panHandlers}>
              <Image
                source={{ uri: photo!.uri }}
                style={{
                  position: 'absolute',
                  width: rect.drawW,
                  height: rect.drawH,
                  left: (frame.width - rect.drawW) / 2 + rect.view.x,
                  top: (frame.height - rect.drawH) / 2 + rect.view.y,
                }}
                contentFit="fill"
              />

              {text.trim() && !writing ? (
                <Pressable style={styles.overlayHit} onPress={() => setWriting(true)}>
                  <Text
                    style={[
                      styles.overlayText,
                      { color: OVERLAY_COLORS[colour] },
                      size === 's' && styles.overlayS,
                      size === 'l' && styles.overlayL,
                    ]}
                  >
                    {text.trim()}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        )}

        {writing ? (
          <View style={styles.writing}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Napíš niečo…"
              placeholderTextColor="rgba(255,255,255,0.5)"
              autoFocus
              multiline
              maxLength={200}
              style={[
                styles.input,
                { color: OVERLAY_COLORS[colour] },
                size === 's' && styles.overlayS,
                size === 'l' && styles.overlayL,
              ]}
            />
            <View style={styles.tools}>
              {(Object.keys(OVERLAY_COLORS) as OverlayColor[]).map((key) => (
                <Pressable
                  key={key}
                  onPress={() => setColour(key)}
                  accessibilityRole="button"
                  style={[
                    styles.swatch,
                    { backgroundColor: OVERLAY_COLORS[key] },
                    colour === key && styles.swatchOn,
                  ]}
                />
              ))}
              {(['s', 'm', 'l'] as OverlaySize[]).map((key) => (
                <Pressable
                  key={key}
                  onPress={() => setSize(key)}
                  style={[styles.sizeChip, size === key && styles.sizeChipOn]}
                >
                  <Text style={styles.sizeLabel}>{key.toUpperCase()}</Text>
                </Pressable>
              ))}
            </View>
            <Button title="Hotovo" onPress={() => setWriting(false)} style={styles.doneText} />
          </View>
        ) : (
          <View style={styles.bar}>
            {/* Tlačidlá, nie posuvník: v prehliadači sa dvoma prstami
                neštipká a bez nich by sa priblížiť nedalo vôbec. */}
            <Pressable
              onPress={() => zoomBy(1 / 1.3)}
              disabled={scale <= 1}
              accessibilityRole="button"
              accessibilityLabel="Oddialiť"
              style={[styles.round, scale <= 1 && styles.roundOff]}
            >
              <Text style={styles.roundGlyph}>－</Text>
            </Pressable>

            <Pressable
              onPress={() => setWriting(true)}
              style={styles.ghost}
              accessibilityRole="button"
            >
              <Text style={styles.ghostLabel}>Aa Text</Text>
            </Pressable>

            <Pressable
              onPress={() => zoomBy(1.3)}
              disabled={scale >= MAX_SCALE}
              accessibilityRole="button"
              accessibilityLabel="Priblížiť"
              style={[styles.round, scale >= MAX_SCALE && styles.roundOff]}
            >
              <Text style={styles.roundGlyph}>＋</Text>
            </Pressable>

            <Button
              title={busy ? 'Pripravujem…' : 'Odoslať'}
              onPress={() => void send()}
              disabled={busy || !usable}
              style={styles.send}
            />
          </View>
        )}

        {!writing ? (
          <Caption style={styles.hint}>
            Ťahaj fotku, kam ju chceš — uloží sa {STORY_WIDTH} × {STORY_HEIGHT}
          </Caption>
        ) : null}
      </View>
    </Modal>
  );
}

/** Vzdialenosť dvoch prstov. */
function distance(touches: { pageX: number; pageY: number }[]): number {
  const [a, b] = touches;
  return a && b ? Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) : 0;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#04060A', paddingTop: Platform.OS === 'web' ? 16 : 48 },
  top: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.lg, paddingBottom: spacing.md,
  },
  close: { color: '#FFFFFF', fontSize: 22 },
  closeSpacer: { width: 22 },
  title: { ...typography.bodyStrong, color: '#FFFFFF' },
  centre: { textAlign: 'center', marginTop: spacing.xxl },

  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  frame: { position: 'relative', overflow: 'hidden', backgroundColor: '#000000' },

  overlayHit: { position: 'absolute', left: 0, right: 0, top: '42%', paddingHorizontal: spacing.lg },
  overlayText: {
    ...typography.subheading, fontSize: 26, lineHeight: 32, textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 6,
  },
  overlayS: { fontSize: 18, lineHeight: 24 },
  overlayL: { fontSize: 36, lineHeight: 42 },

  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
  },
  round: {
    width: 42, height: 42, borderRadius: 21,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)',
  },
  roundOff: { opacity: 0.35 },
  roundGlyph: { color: '#FFFFFF', fontSize: 18 },
  ghost: {
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderRadius: radius.pill, borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)',
  },
  ghostLabel: { ...typography.metaSm, color: '#FFFFFF' },
  send: { minWidth: 130 },

  hint: {
    textAlign: 'center', color: 'rgba(255,255,255,0.6)',
    paddingBottom: Platform.OS === 'web' ? spacing.md : spacing.xl,
  },

  writing: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(4,6,10,0.72)',
    justifyContent: 'center', padding: spacing.lg, gap: spacing.lg,
  },
  input: {
    ...typography.subheading, fontSize: 26, lineHeight: 32, textAlign: 'center',
    minHeight: 60,
  },
  tools: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  swatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: 'transparent' },
  swatchOn: { borderColor: '#FFFFFF' },
  sizeChip: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.chip,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)',
  },
  sizeChipOn: { backgroundColor: 'rgba(255,255,255,0.22)' },
  sizeLabel: { ...typography.monoSm, color: '#FFFFFF' },
  doneText: { alignSelf: 'center', minWidth: 160 },
});
