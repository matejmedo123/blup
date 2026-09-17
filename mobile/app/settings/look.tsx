import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getMyLook, setPremiumLook } from '@/api/premium';
import { useImageCrop } from '@/components/ImageCrop';
import { pickImage, uploadChatWallpaper } from '@/storage/uploads';
import { messageFor } from '@/lib/errors';
import { ACCENTS, useAccent, type AccentKey } from '@/theme/accent';
import {
  Body, Button, Caption, LoadingState, Notice, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * The colour of your BLUP, and the wall behind your chats.
 *
 * Both are Premium, and both are checked on the server — this screen can only
 * ask. Somebody whose subscription lapsed still sees what they chose, greyed
 * out with the reason, because losing a setting is a worse way to be told your
 * card expired than being told your card expired.
 */
export default function LookScreen() {
  const queryClient = useQueryClient();
  const accent = useAccent();
  const { crop } = useImageCrop();

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const look = useQuery({ queryKey: ['premium', 'look'], queryFn: getMyLook });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['premium', 'look'] });
  };

  const choose = async (key: AccentKey) => {
    setError(null);
    setBusy(key);
    try {
      await setPremiumLook({ accent: key });
      await refresh();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  const pickWallpaper = async () => {
    setError(null);
    try {
      const picked = await pickImage({ source: 'library', aspect: [9, 16] });
      if (!picked) return;

      // Through the same cropper as everything else: a wallpaper at the wrong
      // proportions either stretches or leaves a band, and this one sits behind
      // text that has to stay readable.
      const cropped = await crop({
        uri: picked.uri, size: [1080, 1920], title: 'Orezať pozadie chatu',
      });
      if (!cropped) return;

      setBusy('wallpaper');
      const url = await uploadChatWallpaper(cropped);
      await setPremiumLook({ wallpaper: url });
      await refresh();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  const clearWallpaper = async () => {
    setError(null);
    setBusy('wallpaper');
    try {
      await setPremiumLook({ clearWallpaper: true });
      await refresh();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  if (look.isLoading) return <Screen><LoadingState /></Screen>;

  const isPremium = look.data?.is_premium ?? false;
  const savedAccent = (look.data?.saved_accent ?? 'blue') as AccentKey;
  const savedWallpaper = look.data?.saved_wallpaper ?? null;

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Nepodarilo sa" body={error} /> : null}

      {!isPremium ? (
        <Notice
          tone="accent"
          title="Toto má Premium"
          body={
            savedAccent !== 'blue' || savedWallpaper
              ? 'Tvoje nastavenie tu ostalo. Keď sa Premium vráti, vráti sa aj ono — nič sme nezmazali.'
              : 'Farba celej appky a pozadie chatu. Vyskúšať sa to nedá naprázdno, tak si to tu aspoň pozri.'
          }
        />
      ) : null}

      <SectionHeader title="Farba BLUPu" />
      <Body muted style={styles.intro}>
        Prefarbí tlačidlá, prepínače a to, čo je práve vybrané. Šesť farieb, nie paleta — každá
        z nich je čitateľná na tmavom aj s bielym textom na sebe.
      </Body>

      <View style={styles.swatches}>
        {(Object.keys(ACCENTS) as AccentKey[]).map((key) => {
          const palette = ACCENTS[key];
          const isActive = savedAccent === key;

          return (
            <Pressable
              key={key}
              onPress={() => (isPremium ? void choose(key) : router.push('/premium'))}
              disabled={busy !== null}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
              accessibilityLabel={palette.label}
              style={[
                styles.swatch,
                { borderColor: isActive ? palette.accent : colors.border },
                !isPremium && styles.swatchLocked,
              ]}
            >
              <View style={[styles.dot, { backgroundColor: palette.accent }]}>
                {isActive ? <Text style={styles.tick}>✓</Text> : null}
              </View>
              <Caption>{palette.label}</Caption>
            </Pressable>
          );
        })}
      </View>

      {/* What it will look like. Shown with the colour that is actually applied,
          so a lapsed subscriber sees blue here and their own choice above. */}
      <View style={styles.preview}>
        <Caption>Takto to bude vyzerať</Caption>
        <View style={styles.previewRow}>
          <View style={[styles.previewButton, { backgroundColor: accent.accent }]}>
            <Text style={styles.previewButtonLabel}>Idem</Text>
          </View>
          <View style={[styles.previewChip, { backgroundColor: accent.soft, borderColor: accent.border }]}>
            <Text style={[styles.previewChipLabel, { color: accent.text }]}>Techno</Text>
          </View>
        </View>
      </View>

      <SectionHeader title="Pozadie chatu" />
      <Body muted style={styles.intro}>
        Vlastná fotka za správami. Vidíš ju len ty — v cudzom chate sa nezobrazí, takže nikomu
        neprekrýva jeho vlastné.
      </Body>

      {savedWallpaper ? (
        <View style={styles.wallpaperRow}>
          <Image source={{ uri: savedWallpaper }} style={styles.wallpaperThumb} contentFit="cover" />
          <View style={styles.flex}>
            <Body>{isPremium ? 'Nastavené' : 'Uložené, zatiaľ sa nepoužíva'}</Body>
            <Caption>Nová fotka prepíše túto.</Caption>
          </View>
        </View>
      ) : null}

      <View style={styles.actions}>
        <Button
          title={savedWallpaper ? 'Vymeniť fotku' : 'Vybrať fotku'}
          variant="secondary"
          loading={busy === 'wallpaper'}
          onPress={() => (isPremium ? void pickWallpaper() : router.push('/premium'))}
          style={styles.flex}
        />
        {savedWallpaper ? (
          <Button
            title="Odstrániť"
            variant="ghost"
            disabled={!isPremium || busy !== null}
            onPress={() => void clearWallpaper()}
          />
        ) : null}
      </View>

      {!isPremium ? (
        <Button title="Pozrieť Premium" onPress={() => router.push('/premium')} style={styles.cta} />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
  intro: { marginBottom: spacing.md },

  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginBottom: spacing.lg },
  swatch: {
    alignItems: 'center',
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 2,
    backgroundColor: colors.surface,
    minWidth: 92,
  },
  swatchLocked: { opacity: 0.55 },
  dot: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  tick: { color: '#FFFFFF', ...typography.bodyStrong },

  preview: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  previewButton: { paddingHorizontal: spacing.xl, paddingVertical: 10, borderRadius: radius.md },
  previewButtonLabel: { ...typography.bodyStrong, color: '#FFFFFF' },
  previewChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.chip,
    borderWidth: 1,
  },
  previewChipLabel: { ...typography.chip },

  wallpaperRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.md },
  wallpaperThumb: { width: 54, height: 96, borderRadius: radius.md, backgroundColor: colors.surfaceElevated },
  actions: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  cta: { marginTop: spacing.lg },
});
