import React from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  type TextInputProps, type ViewStyle, type StyleProp, type TextStyle,
  type ScrollViewProps,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { Image } from 'expo-image';

import { avatarColorFor, colors, radius, spacing, typography } from '@/theme';
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

/** Small monospace label — "◎ Bratislava", "0 blupov", "[ foto z eventu ]". */
export function Mono({
  children, style, accent, numberOfLines,
}: {
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
  accent?: boolean;
  numberOfLines?: number;
}) {
  return (
    <Text numberOfLines={numberOfLines} style={[styles.mono, accent && { color: colors.accentText }, style]}>
      {children}
    </Text>
  );
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'teal';

export function Button({
  title, onPress, variant = 'primary', loading, disabled, style, icon, compact, full,
}: {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  icon?: string;
  compact?: boolean;
  full?: boolean;
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
        full && styles.buttonFull,
        variant === 'primary' && styles.buttonPrimary,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'ghost' && styles.buttonGhost,
        variant === 'danger' && styles.buttonDanger,
        variant === 'teal' && styles.buttonTeal,
        pressed && !isDisabled && styles.buttonPressed,
        isDisabled && styles.buttonDisabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? '#FFFFFF' : colors.text} />
      ) : (
        <Text
          style={[
            styles.buttonLabel,
            variant === 'primary' && styles.buttonLabelPrimary,
            variant === 'danger' && styles.buttonLabelDanger,
            variant === 'teal' && styles.buttonLabelTeal,
          ]}
        >
          {icon ? `${icon}  ` : ''}{title}
        </Text>
      )}
    </Pressable>
  );
}

/** Round icon button — back arrow, search, filter. */
export function IconButton({
  glyph, onPress, size = 44, badge, style, tone = 'surface',
}: {
  glyph: string;
  onPress?: () => void;
  size?: number;
  badge?: boolean;
  style?: StyleProp<ViewStyle>;
  tone?: 'surface' | 'overlay';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        { width: size, height: size, borderRadius: size / 2 },
        tone === 'overlay' && styles.iconButtonOverlay,
        pressed && styles.iconButtonPressed,
        style,
      ]}
    >
      <Text style={styles.iconGlyph}>{glyph}</Text>
      {badge ? <View style={styles.iconBadge} /> : null}
    </Pressable>
  );
}

/** Two-option switch — "Zoznam / Mapa". */
export function Segmented<T extends string>({
  options, value, onChange, style,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.segmented, style]}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={[styles.segment, active && styles.segmentActive]}
          >
            <Text style={[styles.segmentLabel, active && styles.segmentLabelActive]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
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

/** Labelled box — "KEDY / Dnes · 21:00". */
export function InfoBox({
  label, value, style,
}: {
  label: string;
  value: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.infoBox, style]}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue} numberOfLines={2}>{value}</Text>
    </View>
  );
}

export function Chip({
  label, selected, onPress, style, onCover,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  onCover?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.chip,
        onCover && styles.chipOnCover,
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
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent' | 'teal';
}) {
  const palette: Record<string, { bg: string; fg: string }> = {
    neutral: { bg: colors.surfaceElevated, fg: colors.textSecondary },
    success: { bg: colors.successSoft, fg: colors.success },
    warning: { bg: colors.warningSoft, fg: colors.warning },
    danger: { bg: colors.dangerSoft, fg: colors.danger },
    accent: { bg: colors.accentSoft, fg: colors.accentText },
    teal: { bg: colors.tealSoft, fg: colors.teal },
  };
  const tones = palette[tone];

  return (
    <View style={[styles.badge, { backgroundColor: tones.bg }]}>
      <Text style={[styles.badgeLabel, { color: tones.fg }]}>{label}</Text>
    </View>
  );
}

/** Price pill on a card — "12 €" or "Zdarma". */
export function PricePill({ label, style }: { label: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.pricePill, style]}>
      <Text style={styles.pricePillLabel}>{label}</Text>
    </View>
  );
}

export function Avatar({
  url, name, size = 40, ring,
}: {
  url?: string | null;
  name?: string | null;
  size?: number;
  ring?: boolean;
}) {
  const base = {
    width: size,
    height: size,
    borderRadius: size / 2,
    ...(ring ? { borderWidth: 2, borderColor: colors.background } : {}),
  };

  if (url) {
    return (
      <Image
        source={{ uri: url }}
        style={[base, { backgroundColor: colors.surfaceElevated }]}
        contentFit="cover"
        transition={150}
      />
    );
  }

  // No photo: a vivid, stable colour from the name, like the mockups.
  return (
    <View style={[base, styles.avatarFallback, { backgroundColor: avatarColorFor(name) }]}>
      <Text style={{ color: '#FFFFFF', fontSize: size * 0.34, fontFamily: typography.subheading.fontFamily }}>
        {initialsFor(name)}
      </Text>
    </View>
  );
}

/** Overlapping avatar row — "148 ide". */
export function AvatarStack({
  people, size = 30, max = 5,
}: {
  people: { id: string; avatar_url?: string | null; name?: string | null }[];
  size?: number;
  max?: number;
}) {
  return (
    <View style={styles.avatarStack}>
      {people.slice(0, max).map((person, index) => (
        <View key={person.id} style={{ marginLeft: index === 0 ? 0 : -size * 0.32 }}>
          <Avatar url={person.avatar_url} name={person.name} size={size} ring />
        </View>
      ))}
    </View>
  );
}

/** Full-screen states — every list uses exactly these three. */
export function LoadingState({ label = 'Načítavam…' }: { label?: string }) {
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
  message, onRetry, title = 'Toto nevyšlo',
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
      {onRetry ? <Button title="Skúsiť znova" onPress={onRetry} style={styles.stateAction} /> : null}
    </View>
  );
}

/** Inline banner for non-blocking problems (offline, degraded feature). */
export function Notice({
  tone = 'warning', title, body, actionLabel, onAction,
}: {
  tone?: 'warning' | 'danger' | 'accent' | 'success' | 'teal';
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const palette: Record<string, { bg: string; fg: string }> = {
    warning: { bg: colors.warningSoft, fg: colors.warning },
    danger: { bg: colors.dangerSoft, fg: colors.danger },
    accent: { bg: colors.accentSoft, fg: colors.accentText },
    success: { bg: colors.successSoft, fg: colors.success },
    teal: { bg: colors.tealSoft, fg: colors.teal },
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
  body: { ...typography.body, color: colors.text },
  caption: { ...typography.caption, color: colors.textSecondary },
  mono: { ...typography.mono, color: colors.textSecondary },
  muted: { color: colors.textSecondary },

  button: {
    height: 54,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  buttonCompact: { height: 40, paddingHorizontal: spacing.md, borderRadius: radius.md },
  buttonFull: { alignSelf: 'stretch' },
  buttonPrimary: { backgroundColor: colors.accent },
  buttonSecondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  buttonGhost: { backgroundColor: 'transparent' },
  buttonDanger: { backgroundColor: colors.dangerSoft },
  buttonTeal: { backgroundColor: colors.tealSoft },
  buttonPressed: { opacity: 0.86, transform: [{ scale: 0.99 }] },
  buttonDisabled: { opacity: 0.4 },
  buttonLabel: { ...typography.button, color: colors.text },
  buttonLabelPrimary: { color: '#FFFFFF' },
  buttonLabelDanger: { color: colors.danger },
  buttonLabelTeal: { color: colors.teal },

  iconButton: {
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  iconButtonOverlay: { backgroundColor: colors.overlay, borderColor: 'transparent' },
  iconButtonPressed: { backgroundColor: colors.surfacePressed },
  iconGlyph: { fontSize: 17, color: colors.text },
  iconBadge: {
    position: 'absolute',
    top: 9,
    right: 10,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.danger,
  },

  segmented: { flexDirection: 'row', gap: spacing.sm },
  segment: {
    flex: 1,
    height: 46,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  segmentActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  segmentLabel: { ...typography.bodyStrong, color: colors.textSecondary },
  segmentLabelActive: { color: '#FFFFFF' },

  inputGroup: { marginBottom: spacing.lg },
  inputLabel: { ...typography.captionStrong, color: colors.textSecondary, marginBottom: spacing.sm },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: 15,
    color: colors.text,
    fontSize: 16,
    fontFamily: typography.body.fontFamily,
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

  infoBox: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: 2,
  },
  infoLabel: { ...typography.label, color: colors.textTertiary, textTransform: 'uppercase' },
  infoValue: { ...typography.subheading, color: colors.text },

  chip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 9,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipOnCover: { backgroundColor: colors.chipOnCover, borderColor: 'transparent' },
  chipSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipPressed: { opacity: 0.82 },
  chipLabel: { ...typography.chip, color: colors.textSecondary },
  chipLabelSelected: { color: '#FFFFFF' },

  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    alignSelf: 'flex-start',
  },
  badgeLabel: { ...typography.label },

  pricePill: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 9,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pricePillLabel: { ...typography.subheading, color: colors.text },

  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarStack: { flexDirection: 'row', alignItems: 'center' },

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
    maxWidth: 320,
  },
  stateAction: { marginTop: spacing.lg, minWidth: 240 },
  stateActionSecondary: { minWidth: 240 },

  notice: {
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.xs,
    marginBottom: spacing.lg,
  },
  noticeTitle: { ...typography.bodyStrong },
  noticeBody: { ...typography.caption, color: colors.textSecondary },
  noticeAction: { ...typography.captionStrong, marginTop: spacing.xs, textDecorationLine: 'underline' },

  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center' },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
    marginTop: spacing.xl,
  },
  sectionTitle: { ...typography.heading, color: colors.text },
  sectionAction: { ...typography.captionStrong, color: colors.accentText },

  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    gap: spacing.lg,
  },
  switchLabel: { ...typography.body, color: colors.text },
  switchDescription: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  switchTrack: {
    width: 50,
    height: 30,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceElevated,
    padding: 3,
    justifyContent: 'center',
  },
  switchTrackOn: { backgroundColor: colors.accent },
  switchThumb: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.textTertiary },
  switchThumbOn: { backgroundColor: '#FFFFFF', alignSelf: 'flex-end' },
});
