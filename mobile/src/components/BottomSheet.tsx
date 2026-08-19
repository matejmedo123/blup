import React, { useEffect, useRef } from 'react';
import {
  Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, View,
  type StyleProp, type ViewStyle,
} from 'react-native';

import { colors, radius, spacing, typography } from '@/theme';

/**
 * The bottom sheet from the handoff.
 *
 * Overlay `rgba(4,6,9,.66)`, panel `#12171F` with 28px top corners, a 44×5
 * grabber, a 20/900 title and 20px padding (44 at the bottom). Tapping the
 * overlay closes it, and the panel rises with `blupRise`.
 */
export function BottomSheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
  footer,
  contentStyle,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? 220 : 160,
      easing: visible ? Easing.out(Easing.quad) : Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [visible, progress]);

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.root}>
        <Animated.View style={[styles.overlay, { opacity: progress }]}>
          <Pressable style={styles.overlayPress} onPress={onClose} accessibilityLabel="Zavrieť" />
        </Animated.View>

        <Animated.View
          style={[
            styles.panel,
            {
              opacity: progress,
              transform: [
                { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
              ],
            },
          ]}
        >
          <View style={styles.grabber} />

          {title ? <Text style={styles.title}>{title}</Text> : null}
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={[styles.content, contentStyle]}
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>

          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </Animated.View>
      </View>
    </Modal>
  );
}

/** A key/value line inside a sheet — the ticket breakdown uses these. */
export function SheetRow({
  label, value, strong, tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: 'default' | 'cyan' | 'muted';
}) {
  const valueColor = tone === 'cyan'
    ? colors.cyan
    : tone === 'muted'
      ? colors.textTertiary
      : colors.text;

  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, strong && styles.rowValueStrong, { color: valueColor }]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.overlayModal,
  },
  overlayPress: { flex: 1 },

  panel: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 44,
    maxHeight: '86%',
  },
  grabber: {
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.surfacePressed,
    alignSelf: 'center',
    marginBottom: spacing.xl,
  },
  title: { ...typography.sheetTitle, color: colors.text },
  subtitle: { ...typography.body, color: colors.textSecondary, marginTop: spacing.sm },

  scroll: { flexGrow: 0 },
  content: { paddingTop: spacing.lg, gap: spacing.md },
  footer: { marginTop: spacing.xl },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceInput,
    borderRadius: radius.block,
    paddingHorizontal: spacing.lg,
    paddingVertical: 13,
  },
  rowLabel: { ...typography.body, color: colors.textSecondary },
  rowValue: { ...typography.bodyStrong, color: colors.text },
  rowValueStrong: { ...typography.subheading },
});
