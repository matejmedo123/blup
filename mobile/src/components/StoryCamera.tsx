import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, Easing, Modal, PanResponder, Platform, Pressable, StyleSheet, Text,
  TextInput, View,
  type LayoutChangeEvent,
} from 'react-native';
import { Image } from 'expo-image';
import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import { useVideoPlayer, VideoView } from 'expo-video';

import { messageFor } from '@/lib/errors';
import { Button, Caption, Notice } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';
import { centreCropToStory, storyFrame } from '@/components/storyFormat';
import {
  OVERLAY_COLORS, StoryOverlayText, type OverlayColor,
} from '@/components/StoryOverlayText';
import {
  clampSpot, overlayType, type OverlaySpot, type OverlayTextSize,
} from '@/components/storyOverlayMath';

/**
 * Natáčanie príbehu.
 *
 * Ťuknutie na spúšť je fotka, podržanie je video — a pri podržaní sa okolo
 * spúšte plní krúžok, ktorý po pätnástich sekundách dobehne a nahrávanie
 * skončí samo. Pätnásť sekúnd nie je náhodné číslo: presne tak dlho sa príbeh
 * prehráva, takže dlhšie video by sa aj tak nedopozeralo.
 *
 * Veľkosť sa rieši TU, nie kontrolou po nahratí. Pätnásť sekúnd z telefónu má
 * bežne dvadsať až tridsať megabajtov, lebo kamera natáča 1080p60 pri vysokom
 * dátovom toku. Nahrávanie v 720p s obmedzeným tokom dá za tých istých
 * pätnásť sekúnd jednotky megabajtov — a `maxFileSize` je tvrdý strop, ktorý
 * drží sám záznamník, takže sa nedá prekročiť ani omylom.
 */

/** Ako dlho sa príbeh prehráva, a teda ako dlho sa smie natáčať. */
export const STORY_SECONDS = 15;
/**
 * Strop na súbor, ktorý si stráži samotný záznamník.
 *
 * 720p pri ~3 Mbit/s je za 15 sekúnd asi 5,6 MB; 12 MB je dosť veľká rezerva
 * na scénu plnú pohybu a stále ďaleko od toho, čo by na mobilnom dáta trvalo
 * nahrávať.
 */
const MAX_BYTES = 12 * 1024 * 1024;

/**
 * Farby a veľkosti textu žijú pri komponente, ktorý text kreslí
 * (`StoryOverlayText`). Tu sa len prevezmú ďalej, nech sa staré importy
 * nemusia prepisovať naraz všade.
 */
export type { OverlayColor };
export type OverlaySize = OverlayTextSize;

export interface StoryDraft {
  uri: string;
  kind: 'image' | 'video';
  overlay?: {
    text: string;
    /** Stred textu ako zlomok rámčeka — viď `storyOverlayMath`. */
    x: number;
    y: number;
    color: OverlayColor;
    size: OverlayTextSize;
  };
}

export function StoryCamera({
  visible, onClose, onDone, onLibrary,
}: {
  visible: boolean;
  onClose: () => void;
  onDone: (draft: StoryDraft) => void;
  /**
   * Taking something that is already on the phone.
   *
   * It lives here, beside the shutter, rather than as a second entry point
   * somewhere else — this is where you are when you decide you would rather
   * use yesterday's picture, and it is where every camera puts it.
   */
  onLibrary?: () => void;
}) {
  const camera = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState<CameraType>('back');
  const [recording, setRecording] = useState(false);
  const [shot, setShot] = useState<{ uri: string; kind: 'image' | 'video' } | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Hľadáčik má tvar príbehu, nie tvar snímača.
   *
   * Snímač dáva 4:3 aj vtedy, keď sa príbeh prehráva 9:16. Kým hľadáčik
   * ukazoval celé pole snímača, človek zarámoval jedno a ostatným sa ukázalo
   * niečo iné — hore a dole pribudlo, čo nevidel. Hľadáčik preto ukazuje
   * presne toľko, koľko sa uloží.
   */
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const onStageLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setStage((current) =>
      current.width === width && current.height === height ? current : { width, height });
  }, []);
  const frame = useMemo(
    () => storyFrame(stage.width, stage.height),
    [stage.width, stage.height],
  );

  // --- the text written over the story --------------------------------------
  const [text, setText] = useState('');
  const [colour, setColour] = useState<OverlayColor>('white');
  const [size, setSize] = useState<OverlaySize>('m');
  const [writing, setWriting] = useState(false);
  /** Stred textu ako zlomok rámčeka — v tom sa aj ukladá. */
  const [spot, setSpot] = useState<OverlaySpot>({ x: 0.5, y: 0.5 });

  /**
   * Ťahanie textu.
   *
   * Tu netreba prepínač vrstiev ako v editore: odfotená fotka je už orezaná
   * na tvar príbehu a posúvať sa nedá, takže prst môže patriť textu vždy.
   */
  const dragFrom = useRef({ x: 0.5, y: 0.5 });
  const dragLive = useRef({ spot: { x: 0.5, y: 0.5 }, frame: { width: 1, height: 1 } });
  dragLive.current = {
    spot,
    frame: { width: frame.width || 1, height: frame.height || 1 },
  };
  const textPan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { dragFrom.current = dragLive.current.spot; },
    onPanResponderMove: (_event, gesture) => {
      setSpot(clampSpot({
        x: dragFrom.current.x + gesture.dx / dragLive.current.frame.width,
        y: dragFrom.current.y + gesture.dy / dragLive.current.frame.height,
      }));
    },
  }), []);

  /** 0 → 1 over STORY_SECONDS, drawn as the ring around the shutter. */
  const ring = useRef(new Animated.Value(0)).current;
  /** A press that has already become a recording must not also take a photo. */
  const held = useRef(false);

  const reset = useCallback(() => {
    setShot(null);
    setText('');
    setWriting(false);
    setColour('white');
    setSize('m');
    setError(null);
    setRecording(false);
    held.current = false;
    ring.setValue(0);
  }, [ring]);

  useEffect(() => { if (!visible) reset(); }, [visible, reset]);

  const startRecording = async () => {
    if (!camera.current || recording) return;
    held.current = true;
    setError(null);
    setRecording(true);

    ring.setValue(0);
    Animated.timing(ring, {
      toValue: 1,
      duration: STORY_SECONDS * 1000,
      easing: Easing.linear,
      useNativeDriver: true,
    }).start();

    try {
      // maxDuration and maxFileSize are enforced by the recorder itself, so
      // the clip stops on its own — there is no timer here that could drift
      // away from what is actually being written to disk.
      const video = await camera.current.recordAsync({
        maxDuration: STORY_SECONDS,
        maxFileSize: MAX_BYTES,
      });
      if (video?.uri) setShot({ uri: video.uri, kind: 'video' });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setRecording(false);
      ring.stopAnimation();
      ring.setValue(0);
    }
  };

  const stopRecording = () => {
    if (!recording) return;
    camera.current?.stopRecording();
  };

  const takePhoto = async () => {
    if (!camera.current || recording) return;
    setError(null);
    try {
      const photo = await camera.current.takePictureAsync({ quality: 0.9 });
      if (!photo?.uri) return;
      // Orez na stred na 1080 × 1920, hneď tu. Snímač dal 4:3; hľadáčik
      // ukazoval 9:16 stredom toho poľa, takže stredový výrez je presne to,
      // čo bolo vidno. Robí sa to teraz a nie pri nahrávaní preto, aby sa
      // človek pozeral na to, čo naozaj odošle.
      const framed = await centreCropToStory(photo.uri, photo.width, photo.height);
      setShot({ uri: framed, kind: 'image' });
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  const send = () => {
    if (!shot) return;
    const written = text.trim();
    onDone({
      uri: shot.uri,
      kind: shot.kind,
      // Poloha sa ukladá tá, ktorú je vidno — nie natvrdo stred, ako predtým.
      ...(written
        ? { overlay: { text: written, x: spot.x, y: spot.y, color: colour, size } }
        : {}),
    });
  };

  const body = () => {
    if (!permission) return <Caption style={styles.centre}>Načítavam kameru…</Caption>;

    if (!permission.granted) {
      return (
        <View style={styles.ask}>
          <Text style={styles.askGlyph}>📷</Text>
          <Text style={styles.askTitle}>Na príbeh treba kameru</Text>
          <Caption style={styles.centre}>
            Fotka alebo krátke video — nič sa neodošle, kým sama nestlačíš odoslať.
          </Caption>
          <Button title="Povoliť kameru" onPress={() => void requestPermission()} />
        </View>
      );
    }

    // --- what was just shot, with the text tool over it ---------------------
    if (shot) {
      return (
        <View style={styles.stage} onLayout={onStageLayout}>
          <View style={[styles.frame, frame]}>
            {shot.kind === 'video' ? (
              <DraftVideo uri={shot.uri} />
            ) : (
              // `cover`, lebo fotka je už orezaná na presne tento tvar —
              // `contain` by na nej nemalo čo robiť a pri videu by nechalo
              // pásy, ktoré ostatní neuvidia.
              <Image source={{ uri: shot.uri }} style={styles.fill} contentFit="cover" />
            )}

            {/* Text patrí DNU do rámčeka, nie vedľa neho. Predtým bol
                súrodencom rámčeka a jeho poloha sa tak merala voči celej
                obrazovke — už to samo znamenalo, že pristál inde, než kde ho
                bolo vidno. */}
            {text.trim() && !writing ? (
              <View style={StyleSheet.absoluteFill} {...textPan.panHandlers}>
                <StoryOverlayText
                  text={text}
                  spot={spot}
                  color={colour}
                  size={size}
                  frame={frame}
                />
              </View>
            ) : null}
          </View>

          {text.trim() && !writing ? (
            <Pressable
              onPress={() => setWriting(true)}
              accessibilityRole="button"
              style={styles.editText}
            >
              <Text style={styles.editTextLabel}>Upraviť text</Text>
            </Pressable>
          ) : null}

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
                  overlayType(size, frame.width || 320),
                  { color: OVERLAY_COLORS[colour] },
                ]}
              />

              <View style={styles.tools}>
                {(Object.keys(OVERLAY_COLORS) as OverlayColor[]).map((key) => (
                  <Pressable
                    key={key}
                    onPress={() => setColour(key)}
                    accessibilityRole="button"
                    accessibilityLabel={`Farba ${key}`}
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
          ) : null}

          {!writing ? (
            <View style={styles.draftBar}>
              <Pressable onPress={reset} style={styles.draftGhost} accessibilityRole="button">
                <Text style={styles.draftGhostLabel}>Znova</Text>
              </Pressable>
              <Pressable
                onPress={() => setWriting(true)}
                style={styles.draftGhost}
                accessibilityRole="button"
              >
                <Text style={styles.draftGhostLabel}>Aa Text</Text>
              </Pressable>
              <Button title="Odoslať" onPress={send} style={styles.draftSend} />
            </View>
          ) : null}
        </View>
      );
    }

    // --- the camera ----------------------------------------------------------
    return (
      <View style={styles.stage} onLayout={onStageLayout}>
        <View style={[styles.frame, frame]}>
          <CameraView
            ref={camera}
            style={styles.fill}
            facing={facing}
            mode="video"
            // 720p rather than whatever the sensor can do. This is the whole
            // size fix: a fifteen-second clip lands at a few megabytes instead
            // of thirty, and nothing has to be rejected afterwards.
            videoQuality="720p"
          />
        </View>

        <View style={styles.camBar}>
          <Pressable
            onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))}
            accessibilityRole="button"
            accessibilityLabel="Prepnúť kameru"
            style={styles.flip}
          >
            <Text style={styles.flipGlyph}>⟲</Text>
          </Pressable>

          <View style={styles.shutterWrap}>
            {/* The ring. It fills over the fifteen seconds the recorder is
                allowed, so the clock is on screen rather than in your head. */}
            <Animated.View
              style={[
                styles.ring,
                {
                  opacity: recording ? 1 : 0,
                  transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] }) }],
                },
              ]}
            />
            <Pressable
              onPress={() => { if (!held.current) void takePhoto(); held.current = false; }}
              onLongPress={() => void startRecording()}
              onPressOut={stopRecording}
              delayLongPress={220}
              accessibilityRole="button"
              accessibilityLabel="Ťuknutie fotí, podržanie natáča"
              style={[styles.shutter, recording && styles.shutterOn]}
            />
          </View>

          {onLibrary ? (
            <Pressable
              onPress={() => { onClose(); onLibrary(); }}
              accessibilityRole="button"
              accessibilityLabel="Vybrať z galérie"
              style={styles.flip}
            >
              <Text style={styles.libraryGlyph}>⧉</Text>
            </Pressable>
          ) : (
            <View style={styles.flip} />
          )}
        </View>

        <Caption style={styles.hint}>
          {recording
            ? `Natáčam — najviac ${STORY_SECONDS} sekúnd`
            : `Ťuknutie fotí · podržanie natáča (max ${STORY_SECONDS} s)`}
        </Caption>
      </View>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.screen}>
        <View style={styles.top}>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
            <Text style={styles.close}>✕</Text>
          </Pressable>
          <Text style={styles.title}>Nový príbeh</Text>
          <View style={styles.closeSpacer} />
        </View>

        {error ? <Notice tone="danger" title="Toto sa nepodarilo" body={error} /> : null}

        {body()}
      </View>
    </Modal>
  );
}

/** Prehrá, čo sa práve natočilo — stlmene a dokola, ako sa príbeh prehrá. */
function DraftVideo({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.loop = true;
    instance.muted = true;
    instance.play();
  });
  return <VideoView player={player} style={styles.fill} contentFit="cover" nativeControls={false} />;
}

const SHUTTER = 74;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#04060A', paddingTop: Platform.OS === 'web' ? 16 : 48 },
  top: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.lg, paddingBottom: spacing.md,
  },
  close: { color: '#FFFFFF', fontSize: 22 },
  closeSpacer: { width: 22 },
  title: { ...typography.bodyStrong, color: '#FFFFFF' },

  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  frame: { position: 'relative', overflow: 'hidden', backgroundColor: '#000000' },
  fill: { flex: 1, width: '100%' },
  centre: { textAlign: 'center', marginTop: spacing.xxl },

  ask: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.xl },
  askGlyph: { fontSize: 40 },
  askTitle: { ...typography.subheading, color: '#FFFFFF' },

  camBar: {
    position: 'absolute', left: 0, right: 0, bottom: 56,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around',
  },
  flip: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  flipGlyph: { color: '#FFFFFF', fontSize: 24 },
  libraryGlyph: { color: '#FFFFFF', fontSize: 22 },

  shutterWrap: { width: SHUTTER + 24, height: SHUTTER + 24, alignItems: 'center', justifyContent: 'center' },
  ring: {
    position: 'absolute',
    width: SHUTTER + 20, height: SHUTTER + 20, borderRadius: (SHUTTER + 20) / 2,
    borderWidth: 4, borderColor: colors.accent,
  },
  shutter: {
    width: SHUTTER, height: SHUTTER, borderRadius: SHUTTER / 2,
    backgroundColor: '#FFFFFF', borderWidth: 4, borderColor: 'rgba(255,255,255,0.45)',
  },
  shutterOn: { backgroundColor: colors.danger },

  hint: {
    position: 'absolute', left: 0, right: 0, bottom: 20,
    textAlign: 'center', color: 'rgba(255,255,255,0.75)',
  },

  editText: {
    alignSelf: 'center', marginTop: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)',
  },
  editTextLabel: { ...typography.metaSm, color: '#FFFFFF' },

  writing: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(4,6,10,0.72)',
    justifyContent: 'center', padding: spacing.lg, gap: spacing.lg,
  },
  input: { ...typography.subheading, textAlign: 'center', minHeight: 60 },
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

  draftBar: {
    position: 'absolute', left: 0, right: 0, bottom: 28,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  draftGhost: {
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderRadius: radius.pill, borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)',
  },
  draftGhostLabel: { ...typography.metaSm, color: '#FFFFFF' },
  draftSend: { minWidth: 140 },
});
