import React from 'react';
import {
  ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  type TextInputProps, type ViewStyle, type StyleProp, type TextStyle,
  type ScrollViewProps,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { Image } from 'expo-image';

import { avatarColorFor, colors, radius, spacing, typography, shadow } from '@/theme';
import { useAccent } from '@/theme/accent';
import { initialsFor } from '@/lib/format';
import { CONTENT_MAX, useLayout } from '@/hooks/useLayout';
import { SiteFooter } from './SiteFooter';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';

/** Screen shell: safe area + background, used by every route. */
export function Screen({
  children,
  edges = ['top'],
  scroll = false,
  style,
  contentStyle,
  refreshControl,
  footer = true,
}: {
  children: React.ReactNode;
  edges?: Edge[];
  scroll?: boolean;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  refreshControl?: ScrollViewProps['refreshControl'];
  /**
   * The site footer at the end of the page. On by default for scrollable web
   * screens — it is a website down there — and off for anything that owns its
   * own bottom edge, like the scanner or a full-screen map.
   */
  footer?: boolean;
}) {
  const layout = useLayout();

  // A phone's layout is the window. A desktop's is not: the column widens for
  // the card grids but still stops well short of the monitor, because a line of
  // text 1600 pixels wide is unreadable however much room there is.
  const column = Platform.OS === 'web'
    ? {
        width: '100%' as const,
        maxWidth: layout.isDesktop ? CONTENT_MAX : layout.isWide ? 860 : 760,
        marginHorizontal: 'auto' as const,
      }
    : null;

  const pad = layout.isWide
    ? { padding: spacing.xxl, paddingBottom: spacing.huge }
    : { padding: spacing.lg, paddingBottom: spacing.xxxl };

  // The scroll content fills the screen even when there is little of it, so the
  // footer's `marginTop: auto` has room to push it to the bottom instead of
  // leaving it stranded under a short page.
  const grow = footer && Platform.OS === 'web' ? { flexGrow: 1 } : null;

  // A RefreshControl does nothing on react-native-web, so a screen that had a
  // pull-to-refresh on a phone had none in a browser — including a phone
  // browser. The props are read off the element that was passed rather than
  // asking every screen to hand them over a second way.
  const refreshProps = (refreshControl as { props?: {
    onRefresh?: () => void | Promise<unknown>;
    refreshing?: boolean;
  } } | undefined)?.props;
  const pull = usePullToRefresh(refreshProps?.onRefresh, refreshProps?.refreshing);

  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[pad, column, grow, contentStyle]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      refreshControl={refreshControl}
      {...pull.handlers}
    >
      {pull.indicator}
      {children}
      {footer && Platform.OS === 'web' ? <SiteFooter /> : null}
    </ScrollView>
  ) : (
    <View style={[styles.flex, column, contentStyle]}>{children}</View>
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

/**
 * A button fills the width it is given, up to a point.
 *
 * On a phone that point is wider than the screen, so a primary action still
 * spans the column the way a thumb expects. On a laptop it stops at a readable
 * size instead of stretching a two-word label across a thousand pixels, which
 * reads as a mistake rather than as emphasis.
 *
 * `full` opts out for the rare case that genuinely wants edge-to-edge — a
 * sticky bottom bar, a button sharing a row with a price.
 */
export function Button({
  title, onPress, variant = 'primary', loading, disabled, style, icon, compact, full, large,
}: {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  icon?: string;
  compact?: boolean;
  /** Ignore the width cap and fill the container. */
  full?: boolean;
  /** The 56px screen-bottom CTA. */
  large?: boolean;
}) {
  const isDisabled = disabled || loading;
  // The one colour Premium repaints. Read here rather than baked into the
  // stylesheet, because StyleSheet.create captures its values at import and a
  // colour chosen afterwards would change nothing.
  const accent = useAccent();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        large && styles.buttonLarge,
        compact && styles.buttonCompact,
        full && styles.buttonFull,
        variant === 'primary' && styles.buttonPrimary,
        variant === 'primary' && { backgroundColor: accent.accent },
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
            large && styles.buttonLabelLarge,
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
  const accent = useAccent();

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
            style={[
              styles.segment,
              active && styles.segmentActive,
              active && { backgroundColor: accent.accent },
            ]}
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

/**
 * Lays children out in as many columns as the window can honestly hold: one on
 * a phone, two on a laptop, three on a wide monitor. Gaps come from the grid
 * rather than each card's own margin, so a card looks the same wherever it is
 * used.
 *
 * Deliberately not a FlatList: these lists are tens of items, not thousands,
 * and virtualisation inside a page-level ScrollView measures wrong on web.
 */
export function CardGrid({
  children, minWidth, style,
}: {
  children: React.ReactNode;
  /** Narrowest a card may get before the grid drops a column. */
  minWidth?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const layout = useLayout();
  const items = React.Children.toArray(children).filter(Boolean);

  if (!layout.isWide || items.length === 0) {
    return <View style={[styles.gridStack, style]}>{items}</View>;
  }

  const columns = layout.columns;
  const basis = `${100 / columns}%` as `${number}%`;

  return (
    <View style={[styles.grid, style]}>
      {items.map((child, index) => (
        <View
          key={index}
          style={[styles.gridCell, { flexBasis: basis, maxWidth: basis, minWidth: minWidth ?? 280 }]}
        >
          {child}
        </View>
      ))}
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
  const accent = useAccent();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.chip,
        onCover && styles.chipOnCover,
        selected && styles.chipSelected,
        selected && { backgroundColor: accent.accent },
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
  const accent = useAccent();
  const palette: Record<string, { bg: string; fg: string }> = {
    neutral: { bg: colors.surfaceElevated, fg: colors.textSecondary },
    success: { bg: colors.successSoft, fg: colors.success },
    warning: { bg: colors.warningSoft, fg: colors.warning },
    danger: { bg: colors.dangerSoft, fg: colors.danger },
    accent: { bg: accent.soft, fg: accent.text },
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
  url, name, size = 40, ring, square,
}: {
  url?: string | null;
  name?: string | null;
  size?: number;
  ring?: boolean;
  /** The handoff uses radius-16 rectangles for list rows, circles elsewhere. */
  square?: boolean;
}) {
  const base = {
    width: size,
    height: size,
    borderRadius: square ? radius.md : size / 2,
    ...(ring ? { borderWidth: 2, borderColor: colors.surface } : {}),
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
      <Text style={{
        color: colors.textInverse,
        fontSize: size * 0.34,
        fontFamily: typography.rowTitle.fontFamily,
      }}>
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
        <View key={person.id} style={{ marginLeft: index === 0 ? 0 : -8 }}>
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
  title, action, onAction, centered = false,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  /** Centres the heading over a centred block, e.g. crews and comments. */
  centered?: boolean;
}) {
  return (
    <View style={[styles.sectionHeader, centered && styles.sectionHeaderCentered]}>
      <Text style={[styles.sectionTitle, centered && styles.sectionTitleCentered]}>{title}</Text>
      {action && onAction ? (
        <Pressable onPress={onAction} hitSlop={8}>
          <Text style={styles.sectionAction}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * One group of a long form, on its own ground.
 *
 * A form built as a flat stack of headings and fields reads as one wall — the
 * event form had six groups in it and no two of them looked separate, so the
 * question you were answering was whichever one you happened to be looking at.
 * A panel gives each group a surface, a title and its own padding, which is the
 * cheapest way to make "where does this section end" visible without drawing
 * lines everywhere.
 *
 * `hint` is the sentence under the title that says why the group exists; it
 * belongs to the group rather than floating above the first field.
 */
export function Panel({
  title, hint, children, style,
}: {
  title?: string;
  hint?: string;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.panel, style]}>
      {title ? <Text style={styles.panelTitle}>{title}</Text> : null}
      {hint ? <Text style={styles.panelHint}>{hint}</Text> : null}
      {children}
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
  const accent = useAccent();

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
      <View style={[
        styles.switchTrack,
        value && styles.switchTrackOn,
        value && { backgroundColor: accent.accent },
      ]}>
        <View style={[styles.switchThumb, value && styles.switchThumbOn]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  panelTitle: { ...typography.subheading, color: colors.text, marginBottom: spacing.xs },
  panelHint: { ...typography.caption, color: colors.textSecondary, marginBottom: spacing.md },

  gridStack: { gap: spacing.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -spacing.sm },
  gridCell: { paddingHorizontal: spacing.sm, paddingBottom: spacing.lg },
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
  screen: { flex: 1, backgroundColor: colors.background },

  title: { ...typography.title, color: colors.text },
  heading: { ...typography.heading, color: colors.text },
  body: { ...typography.body, color: colors.text },
  caption: { ...typography.caption, color: colors.textSecondary },
  mono: { ...typography.mono, color: colors.textSecondary },
  muted: { color: colors.textSecondary },

  button: {
    height: 50,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    paddingHorizontal: spacing.xl,
    // Wider than any phone's content column, so nothing changes on a phone —
    // and narrow enough that a desktop button looks like a button.
    maxWidth: 360,
    // Centred, because the cap above makes the button narrower than what it
    // sits in: left-aligned it drifted away from the centred inputs, headings
    // and links around it and read as a mistake. `width: 100%` has to come with
    // it — `alignSelf: center` alone makes a flex child shrink to its label,
    // which turned the sign-in CTA into a 116px pill.
    alignSelf: 'center',
    width: '100%',
    // Breathing room, so two stacked buttons are two buttons rather than one
    // block split by a hairline. Halved on each so the gap between them is
    // spacing.md and the gap to anything else stays spacing.sm.
    marginVertical: spacing.sm,
  },
  // A compact button is an inline control — "Navigovať" beside an address,
  // "Odstrániť" beside a row label. It must size to its own text: inheriting
  // the base `width: 100%` made it claim the whole row and squeeze its sibling
  // to nothing, which on react-native-web wraps that sibling's text one
  // character per line. flexShrink: 0 keeps the label itself off that fate.
  buttonCompact: {
    height: 40,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.block,
    width: 'auto',
    maxWidth: undefined,
    alignSelf: 'auto',
    flexShrink: 0,
  },
  /** The full-width primary CTA from the handoff: 56 tall, radius 18. */
  buttonLarge: { height: 56, borderRadius: 18 },
  buttonFull: { alignSelf: 'stretch', maxWidth: undefined },
  // In a row the parent decides the gaps; the vertical margin would only push
  // the row apart from its neighbours.
  buttonInRow: { marginVertical: 0, width: 'auto', maxWidth: undefined, alignSelf: 'auto' },
  buttonPrimary: { backgroundColor: colors.accent, ...shadow.cta },
  buttonSecondary: { backgroundColor: colors.surfaceElevated2 },
  buttonGhost: { backgroundColor: 'transparent' },
  buttonDanger: { backgroundColor: colors.dangerSoft },
  buttonTeal: { backgroundColor: colors.tealSoft },
  buttonPressed: { opacity: 0.9, transform: [{ scale: 0.99 }] },
  buttonDisabled: { opacity: 0.4 },
  buttonLabel: { ...typography.buttonSm, color: colors.text },
  buttonLabelLarge: { ...typography.button },
  buttonLabelPrimary: { color: '#FFFFFF' },
  buttonLabelDanger: { color: colors.danger },
  buttonLabelTeal: { color: colors.teal },

  iconButton: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.block,
  },
  iconButtonOverlay: { backgroundColor: colors.overlay, borderColor: 'transparent' },
  iconButtonPressed: { backgroundColor: '#1D242F' },
  iconGlyph: { fontSize: 17, color: colors.textSecondary },
  iconBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.pink,
  },

  segmented: { flexDirection: 'row', gap: spacing.sm },
  segment: {
    flex: 1,
    height: 42,
    borderRadius: radius.chip,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceElevated,
  },
  segmentActive: { backgroundColor: colors.accent },
  segmentLabel: { ...typography.chip, fontSize: 14, color: colors.textSecondary },
  segmentLabelActive: { color: '#FFFFFF' },

  inputGroup: { marginBottom: spacing.lg },
  inputLabel: { ...typography.captionStrong, color: colors.textSecondary, marginBottom: spacing.sm },
  input: {
    backgroundColor: colors.surfaceInput,
    borderRadius: radius.input,
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
    ...typography.body,
  },
  inputError: { borderColor: colors.danger },
  errorText: { ...typography.caption, color: colors.danger, marginTop: spacing.xs },
  hintText: { ...typography.caption, color: colors.textTertiary, marginTop: spacing.xs },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
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
    paddingHorizontal: 15,
    paddingVertical: 11,
    borderRadius: radius.chip,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipOnCover: { backgroundColor: colors.chipOnCover, borderColor: 'transparent' },
  chipSelected: { backgroundColor: colors.accent },
  chipPressed: { opacity: 0.82 },
  chipLabel: { ...typography.chip, fontSize: 14, color: colors.textSecondary },
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
  sectionHeaderCentered: { justifyContent: 'center' },
  sectionTitle: { ...typography.heading, color: colors.text },
  sectionTitleCentered: { textAlign: 'center', flex: 1 },
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
