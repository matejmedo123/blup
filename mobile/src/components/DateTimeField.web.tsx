import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radius, spacing, typography } from '@/theme';

/**
 * Web version of the date/time field.
 *
 * @react-native-community/datetimepicker is native-only, so the web bundle uses
 * two plain inputs. Values are parsed strictly and an invalid entry is left
 * alone rather than silently snapping to some other date.
 */
export function DateTimeField({
  value,
  onChange,
  label = 'Začiatok',
}: {
  value: Date;
  onChange: (next: Date) => void;
  label?: string;
  minimumDate?: Date;
}) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateText = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  const timeText = `${pad(value.getHours())}:${pad(value.getMinutes())}`;

  const applyDate = (text: string) => {
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return;

    const next = new Date(value);
    next.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (!Number.isNaN(next.getTime())) onChange(next);
  };

  const applyTime = (text: string) => {
    const match = text.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return;

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return;

    const next = new Date(value);
    next.setHours(hours, minutes, 0, 0);
    onChange(next);
  };

  return (
    <View style={styles.wrapper}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        <TextInput
          defaultValue={dateText}
          onChangeText={applyDate}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.textTertiary}
          style={[styles.input, styles.dateInput]}
        />
        <TextInput
          defaultValue={timeText}
          onChangeText={applyTime}
          placeholder="HH:MM"
          placeholderTextColor={colors.textTertiary}
          style={[styles.input, styles.timeInput]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { marginBottom: spacing.md, gap: spacing.sm },
  label: { ...typography.caption, color: colors.textSecondary },
  row: { flexDirection: 'row', gap: spacing.sm },
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
  dateInput: { flex: 2 },
  timeInput: { flex: 1 },
});
