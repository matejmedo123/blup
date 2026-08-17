import React from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  type TextInputProps, type ViewStyle, type StyleProp, type TextStyle,
  type ScrollViewProps,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { Image } from 'expo-image';

import { colors, radius, spacing, typography } from '@/theme';
import { initialsFor } from '@/lib/format';

/** Screen shell: safe area + background, used by every route. */
export function Screen({
  children,
  edges = ['top'],
  scroll = false,
  style,
  contentStyle,
  refreshControl,
}: {
  children: React.ReactNode;
  edges?: Edge[];
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  refreshControl?: ScrollViewProps['refreshControl'];
}) {
  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[{ padding: spacing.lg, paddingBottom: spacing.xxxl }, contentStyle]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      refreshControl={refreshControl}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, contentStyle]}>{children}</View>
  );

  return <SafeAreaView style={[styles.screen, style]} edges={edges}>{body}</SafeAreaView>;
}

export function Heading({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.heading, style]}>{children}</Text>;
}

export function Title({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.title, style]}>{children}</Text>;
}

export function Body({
  children, muted, style, numberOfLines,
}: {
  children: React.ReactNode;
  muted?: boolean;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  return (
    <Text numberOfLines={numberOfLines} style={[styles.body, muted && styles.muted, style]}>
      {children}
    </Text>
  );
}

export function Caption({
  children, style, numberOfLines,
}: {
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  return (
    <Text numberOfLines={numberOfLines} style={[styles.caption, style]}>
      {children}
    </Text>
  );
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  title, onPress, variant = 'primary', loading, disabled, style, icon, compact,
}: {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  icon?: string;
  compact?: boolean;
}) {
  const isDisabled = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        variant === 'primary' && styles.buttonPrimary,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'ghost' && styles.buttonGhost,
        variant === 'danger' && styles.buttonDanger,
        pressed && !isDisabled && styles.buttonPressed,
        isDisabled && styles.buttonDisabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? colors.textInverse : colors.text} />
      ) : (
        <Text
          style={[
            styles.buttonLabel,
            variant === 'primary' && styles.buttonLabelPrimary,
            variant === 'danger' && styles.buttonLabelDanger,
          ]}
        >
          {icon ? `${icon}  ` : ''}{title}
        </Text>
      )}
    </Pressable>
  );
}

export function Input({
  label, error, hint, style, ...props
}: TextInputProps & { label?: string; error?: string | null; hint?: string }) {
  return (
    <View style={styles.inputGroup}>
      {label ? <Text style={styles.inputLabel}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.textTertiary}
        style={[styles.input, error ? styles.inputError : null, style]}
        {...props}
      />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      {!error && hint ? <Text style={styles.hintText}>{hint}</Text> : null}
    </View>
  );
}

export function Card({
  children, style, onPress,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
}) {
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.card, pressed && styles.cardPressed, style]}
      >
        {children}
      </Pressable>
    );
  }
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Chip({
  label, selected, onPress, style,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        pressed && onPress ? styles.chipPressed : null,
        style,
      ]}
    >
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

export function Badge({
  label, tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent';
}) {
  const toneStyles: Record<string, { bg: string; fg: string }> = {
    neutral: { bg: colors.surfaceElevated, fg: colors.textSecondary },
    success: { bg: colors.successSoft, fg: colors.success },
    warning: { bg: colors.warningSoft, fg: colors.warning },
    danger: { bg: colors.dangerSoft, fg: colors.danger },
    accent: { bg: colors.accentSoft, fg: colors.accent },
  };
  const palette = toneStyles[tone];

  return (
    <View style={[styles.badge, { backgroundColor: palette.bg }]}>
      <Text style={[styles.badgeLabel, { color: palette.fg }]}>{label}</Text>
    </View>
  );
}

export function Avatar({
  url, name, size = 40,
}: {
  url?: string | null;
  name?: string | null;
  size?: number;
}) {
  if (url) {
    return (
      <Image
        source={{ uri: url }}
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.surfaceElevated }}
        contentFit="cover"
        transition={150}
      />
    );
  }

  return (
    <View
      style={[
        styles.avatarFallback,
        { width: size, height: size, borderRadius: size / 2 },
      ]}
    >
      <Text style={{ color: colors.textSecondary, fontSize: size * 0.36, fontWeight: '700' }}>
        {initialsFor(name)}
      </Text>
    </View>
  );
}

/** Full-screen states — every list uses exactly these three. */
export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <View style={styles.stateContainer}>
      <ActivityIndicator color={colors.accent} size="large" />
      <Text style={styles.stateBody}>{label}</Text>
    </View>
  );
}

export function EmptyState({
  emoji = '🫧', title, body, actionLabel, onAction, secondaryLabel, onSecondary,
}: {
  emoji?: string;
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  return (
    <View style={styles.stateContainer}>
      <Text style={styles.stateEmoji}>{emoji}</Text>
      <Text style={styles.stateTitle}>{title}</Text>
      {body ? <Text style={styles.stateBody}>{body}</Text> : null}
      {actionLabel && onAction ? (
        <Button title={actionLabel} onPress={onAction} style={styles.stateAction} />
      ) : null}
      {secondaryLabel && onSecondary ? (
        <Button
          title={secondaryLabel}
          variant="ghost"
          onPress={onSecondary}
          style={styles.stateActionSecondary}
        />
      ) : null}
    </View>
  );
}

export function ErrorState({
  message, onRetry, title = 'That did not work',
}: {
  message: string;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <View style={styles.stateContainer}>
      <Text style={styles.stateEmoji}>⚠️</Text>
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.stateBody}>{message}</Text>
      {onRetry ? <Button title="Try again" onPress={onRetry} style={styles.stateAction} /> : null}
    </View>
  );
}

/** Inline banner for non-blocking problems (offline, degraded feature). */
export function Notice({
  tone = 'warning', title, body, actionLabel, onAction,
}: {
  tone?: 'warning' | 'danger' | 'accent' | 'success';
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const palette: Record<string, { bg: string; fg: string }> = {
    warning: { bg: colors.warningSoft, fg: colors.warning },
    danger: { bg: colors.dangerSoft, fg: colors.danger },
    accent: { bg: colors.accentSoft, fg: colors.accent },
    success: { bg: colors.successSoft, fg: colors.success },
  };

  return (
    <View style={[styles.notice, { backgroundColor: palette[tone].bg }]}>
      <Text style={[styles.noticeTitle, { color: palette[tone].fg }]}>{title}</Text>
      {body ? <Text style={styles.noticeBody}>{body}</Text> : null}
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} hitSlop={8}>
          <Text style={[styles.noticeAction, { color: palette[tone].fg }]}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.divider, style]} />;
}

export function Row({
  children, style, gap = spacing.sm,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  gap?: number;
}) {
  return <View style={[styles.row, { gap }, style]}>{children}</View>;
}

export function SectionHeader({
  title, action, onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action && onAction ? (
        <Pressable onPress={onAction} hitSlop={8}>
          <Text style={styles.sectionAction}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Switch({
  value, onValueChange, label, description,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      onPress={() => onValueChange(!value)}
      style={styles.switchRow}
    >
      <View style={styles.flex}>
        <Text style={styles.switchLabel}>{label}</Text>
        {description ? <Text style={styles.switchDescription}>{description}</Text> : null}
      </View>
      <View style={[styles.switchTrack, value && styles.switchTrackOn]}>
        <View style={[styles.switchThumb, value && styles.switchThumbOn]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background },

  title: { ...typography.title, color: colors.text },
  heading: { ...typography.heading, color: colors.text },
  body: { ...typography.body, color: colors.text, lineHeight: 21 },
  caption: { ...typography.caption, color: colors.textSecondary },
  muted: { color: colors.textSecondary },

  button: {
    height: 50,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  buttonCompact: { height: 38, paddingHorizontal: spacing.md },
  buttonPrimary: { backgroundColor: colors.accent },
  buttonSecondary: { backgroundColor: colors.surfaceElevated },
  buttonGhost: { backgroundColor: 'transparent' },
  buttonDanger: { backgroundColor: colors.dangerSoft },
  buttonPressed: { opacity: 0.85, transform: [{ scale: 0.99 }] },
  buttonDisabled: { opacity: 0.45 },
  buttonLabel: { ...typography.bodyStrong, color: colors.text },
  buttonLabelPrimary: { color: colors.textInverse },
  buttonLabelDanger: { color: colors.danger },

  inputGroup: { marginBottom: spacing.lg },
  inputLabel: { ...typography.caption, color: colors.textSecondary, marginBottom: spacing.sm },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
    color: colors.text,
    fontSize: 16,
  },
  inputError: { borderColor: colors.danger },
  errorText: { ...typography.caption, color: colors.danger, marginTop: spacing.xs },
  hintText: { ...typography.caption, color: colors.textTertiary, marginTop: spacing.xs },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardPressed: { backgroundColor: colors.surfacePressed },

  chip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipSelected: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  chipPressed: { opacity: 0.8 },
  chipLabel: { ...typography.caption, color: colors.textSecondary },
  chipLabelSelected: { color: colors.accent },

  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
    alignSelf: 'flex-start',
  },
  badgeLabel: { ...typography.micro },

  avatarFallback: {
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },

  stateContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  stateEmoji: { fontSize: 44, marginBottom: spacing.xs },
  stateTitle: { ...typography.heading, color: colors.text, textAlign: 'center' },
  stateBody: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 21,
    maxWidth: 320,
  },
  stateAction: { marginTop: spacing.lg, minWidth: 220 },
  stateActionSecondary: { minWidth: 220 },

  notice: {
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.xs,
    marginBottom: spacing.lg,
  },
  noticeTitle: { ...typography.bodyStrong },
  noticeBody: { ...typography.caption, color: colors.textSecondary, lineHeight: 19 },
  noticeAction: { ...typography.caption, marginTop: spacing.xs, textDecorationLine: 'underline' },

  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center' },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
    marginTop: spacing.xl,
  },
  sectionTitle: { ...typography.subheading, color: colors.text },
  sectionAction: { ...typography.caption, color: colors.accent },

  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    gap: spacing.lg,
  },
  switchLabel: { ...typography.body, color: colors.text },
  switchDescription: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  switchTrack: {
    width: 48,
    height: 28,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceElevated,
    padding: 3,
    justifyContent: 'center',
  },
  switchTrackOn: { backgroundColor: colors.accent },
  switchThumb: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.textSecondary,
  },
  switchThumbOn: { backgroundColor: colors.textInverse, alignSelf: 'flex-end' },
});
