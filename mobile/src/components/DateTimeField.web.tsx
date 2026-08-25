import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing, typography } from '@/theme';

/**
 * Web version of the date/time field.
 *
 * @react-native-community/datetimepicker is native-only. Typing a date as
 * `YYYY-MM-DD` into a plain text box worked, but nobody wants to type a date —
 * they want to look at a month and point at a day. The browser already has
 * both a calendar and a clock built in, so this uses them: `<input type="date">`
 * and `<input type="time">`, styled to look like the rest of the form.
 *
 * The inputs are controlled but only report *valid* values upwards — a
 * half-typed date is left alone rather than snapping the event to year 0002.
 */
export function DateTimeField({
  value,
  onChange,
  label = 'Začiatok',
  minimumDate,
}: {
  value: Date;
  onChange: (next: Date) => void;
  label?: string;
  minimumDate?: Date;
}) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const asDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const dateText = asDate(value);
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

  // A DOM element, deliberately: this is the web bundle, and the browser's own
  // date picker is better than anything worth rebuilding here.
  const input = (props: Record<string, unknown>) =>
    React.createElement('input', {
      ...props,
      style: {
        backgroundColor: colors.surface,
        borderRadius: radius.md,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: colors.border,
        padding: '13px 16px',
        color: colors.text,
        fontSize: 16,
        fontFamily: 'inherit',
        // Makes the browser paint its calendar and its picker glyph for a dark
        // form instead of a white box with an invisible icon.
        colorScheme: 'dark',
        width: '100%',
        boxSizing: 'border-box',
        outline: 'none',
      },
    });

  return (
    <View style={styles.wrapper}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        <View style={styles.dateCell}>
          {input({
            type: 'date',
            value: dateText,
            min: minimumDate ? asDate(minimumDate) : undefined,
            'aria-label': `${label} — dátum`,
            onChange: (event: { target: { value: string } }) => applyDate(event.target.value),
          })}
        </View>
        <View style={styles.timeCell}>
          {input({
            type: 'time',
            value: timeText,
            'aria-label': `${label} — čas`,
            onChange: (event: { target: { value: string } }) => applyTime(event.target.value),
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { marginBottom: spacing.md, gap: spacing.sm },
  label: { ...typography.caption, color: colors.textSecondary },
  row: { flexDirection: 'row', gap: spacing.sm },
  dateCell: { flex: 2 },
  timeCell: { flex: 1 },
});
