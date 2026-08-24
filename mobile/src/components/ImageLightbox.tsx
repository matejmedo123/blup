import React, { useCallback, useEffect } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';

import { colors, spacing, typography } from '@/theme';

/**
 * Full-screen viewer for a photo that was too small to see.
 *
 * A chat photo is 220px wide and an event tile is half a column; both are
 * thumbnails of something somebody wanted to show. Tapping one had no effect
 * at all, which reads as a broken image rather than as a small one.
 *
 * Deliberately plain: a backdrop, the picture at its own proportions, and
 * three ways out — the close button, the backdrop, and Escape on a keyboard.
 * Pinch-to-zoom would need a gesture handler around it and is not what the
 * complaint was about.
 */
export function ImageLightbox({
  uri,
  caption,
  onClose,
}: {
  /** null closes the viewer; a uri opens it. */
  uri: string | null;
  caption?: string | null;
  onClose: () => void;
}) {
  const visible = Boolean(uri);

  // Escape is the reflex on a desktop, and this is a web-first product.
  const onKey = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Escape') onClose();
  }, [onClose]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, onKey]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      // Android's back button, and the web's history back.
      statusBarTranslucent
    >
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Zavrieť fotku">
        {/* Swallows taps on the picture itself, so only the backdrop closes. */}
        <Pressable style={styles.stage} onPress={() => {}}>
          {uri ? (
            <Image
              source={{ uri }}
              style={styles.image}
              contentFit="contain"
              transition={120}
              accessibilityLabel={caption ?? 'Fotka'}
            />
          ) : null}
          {caption ? <Text style={styles.caption}>{caption}</Text> : null}
        </Pressable>
      </Pressable>

      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Zavrieť"
        hitSlop={12}
        style={styles.close}
      >
        <Text style={styles.closeGlyph}>×</Text>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  stage: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' },
  image: { width: '100%', height: '86%' },
  caption: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.md,
    textAlign: 'center',
  },
  close: {
    position: 'absolute',
    top: 44,
    right: 18,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  closeGlyph: { color: '#FFFFFF', fontSize: 26, lineHeight: 30 },
});
