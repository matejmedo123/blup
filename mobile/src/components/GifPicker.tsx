import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useQuery } from '@tanstack/react-query';

import { searchGifs, type Gif } from '@/api/gifs';
import { pickGif } from '@/storage/uploads';
import { messageFor } from '@/lib/errors';
import { BottomSheet } from '@/components/BottomSheet';
import { Caption, Input, LoadingState, Notice } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Picking a GIF.
 *
 * Two ways in, and the second one always works. Search goes through our own
 * Edge Function so the provider key never ships inside the app; when this
 * deployment has no key the grid is replaced by a plain sentence saying search
 * is not set up here — not an empty grid, and not a search box that silently
 * returns nothing for ever.
 *
 * "Vlastný GIF" needs no provider at all: it picks a .gif out of the library
 * and hands back a file URI. Either way the caller gets something to upload,
 * and the upload path deliberately skips the JPEG re-encode every other picture
 * in this app goes through — that would turn the animation into a still.
 */
export function GifPicker({
  visible, onClose, onPick,
}: {
  visible: boolean;
  onClose: () => void;
  /** A https URL from the search, or a local file:// URI from the library. */
  onPick: (source: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const results = useQuery({
    queryKey: ['gifs', query.trim()],
    queryFn: () => searchGifs({ query: query.trim(), limit: 24 }),
    enabled: visible,
    // A GIF library does not change minute to minute, and every call costs the
    // project's quota.
    staleTime: 10 * 60_000,
    retry: false,
  });

  const fromLibrary = async () => {
    setError(null);
    try {
      const picked = await pickGif();
      if (!picked) return;
      onPick(picked.uri);
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  const unavailable = results.data?.configured === false;
  const failed = results.isError;

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Pošli GIF"
      subtitle="Vyhľadaj, alebo použi vlastný zo svojich fotiek."
    >
      {error ? <Notice tone="danger" title="Toto sa nepodarilo" body={error} /> : null}

      {!unavailable && !failed ? (
        <Input
          value={query}
          onChangeText={setQuery}
          placeholder="Hľadaj GIF…"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={styles.input}
        />
      ) : null}

      <Pressable
        onPress={() => void fromLibrary()}
        accessibilityRole="button"
        style={({ pressed }) => [styles.ownRow, pressed && styles.pressed]}
      >
        <Text style={styles.ownGlyph}>＋</Text>
        <View style={styles.flex}>
          <Text style={styles.ownLabel}>Vlastný GIF</Text>
          <Caption>Zo svojich fotiek. Pošle sa ako animácia, nie ako fotka.</Caption>
        </View>
      </Pressable>

      {unavailable ? (
        // Honest rather than empty. Somebody looking at a grid that never fills
        // cannot tell a missing key from a bad connection.
        <Notice
          tone="warning"
          title="Vyhľadávanie GIFov tu nie je nastavené"
          body="Táto inštalácia nemá kľúč k poskytovateľovi GIFov. Vlastný GIF z fotiek funguje aj tak."
        />
      ) : failed ? (
        <Notice
          tone="warning"
          title="Vyhľadávanie práve nejde"
          body="Poskytovateľ GIFov neodpovedá. Skús o chvíľu — alebo pošli vlastný GIF."
        />
      ) : results.isLoading ? (
        <LoadingState label="Hľadám GIFy…" />
      ) : (
        <FlatList
          data={results.data?.gifs ?? []}
          keyExtractor={(item) => item.id}
          numColumns={3}
          columnWrapperStyle={styles.gridRow}
          contentContainerStyle={styles.grid}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          style={styles.list}
          renderItem={({ item }) => <GifTile gif={item} onPress={() => onPick(item.url)} />}
          ListEmptyComponent={
            <Caption style={styles.empty}>
              {query.trim() ? 'Na toto nič nemám.' : 'Zatiaľ tu nič nie je.'}
            </Caption>
          }
        />
      )}
    </BottomSheet>
  );
}

function GifTile({ gif, onPress }: { gif: Gif; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={gif.description}
      style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
    >
      <Image
        source={{ uri: gif.preview_url }}
        style={styles.tileImage}
        contentFit="cover"
        transition={120}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.6 },
  input: { marginBottom: spacing.md },

  ownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  ownGlyph: { fontSize: 20, color: colors.accent },
  ownLabel: { ...typography.bodyStrong, color: colors.text },

  // Capped so the sheet does not grow past the screen on a tall phone.
  list: { maxHeight: 320 },
  grid: { gap: spacing.sm },
  gridRow: { gap: spacing.sm },
  tile: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.surfaceElevated,
  },
  tileImage: { width: '100%', height: '100%' },
  empty: { paddingVertical: spacing.lg, textAlign: 'center' },
});
