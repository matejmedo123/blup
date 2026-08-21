import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';

import { formatEventDateLong } from '@/lib/format';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Start date + time picker.
 *
 * Native: the platform picker, walked through date then time.
 * Web: see DateTimeField.web.tsx — the native module has no web build, so the
 * web bundle uses plain inputs instead of crashing.
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
  const [mode, setMode] = useState<'date' | 'time' | null>(null);

  return (
    <View style={styles.wrapper}>
      <Pressable style={styles.button} onPress={() => setMode('date')}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.value}>{formatEventDateLong(value.toISOString())}</Text>
      </Pressable>

      {mode ? (
        <DateTimePicker
          value={value}
          mode={mode}
          display="spinner"
          themeVariant="dark"
          minimumDate={minimumDate}
          onChange={(event, selected) => {
            if (event.type === 'dismissed') {
              setMode(null);
              return;
            }
            if (selected) onChange(selected);
            // Pick the day first, then roll straight into the time.
            setMode(mode === 'date' ? 'time' : null);
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { marginBottom: spacing.md },
  button: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  label: { ...typography.caption, color: colors.textSecondary },
  value: { ...typography.bodyStrong, color: colors.text },
});
