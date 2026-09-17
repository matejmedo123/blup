import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radius, spacing, typography } from '@/theme';

/**
 * Asking before something irreversible — on every platform.
 *
 * `Alert.alert` in react-native-web is literally `static alert() {}`: an empty
 * function. Every confirmation written with it did nothing at all in a browser,
 * so the button it guarded did nothing either — deleting a gallery photo was
 * the one that got noticed, and reporting an event (`Alert.prompt`, which does
 * not exist on web at all) was the one that had not been. A button that quietly
 * refuses is worse than no button.
 *
 * So the dialog is ours: the same component on phone and web, keyboard-closable,
 * and awaited rather than passed a callback.
 */
type ConfirmOptions = {
  title: string;
  body?: string;
  /** Label of the button that does the thing. */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Paints the confirm button red and marks it destructive on iOS. */
  destructive?: boolean;
};

type PromptOptions = ConfirmOptions & {
  placeholder?: string;
  initialValue?: string;
  multiline?: boolean;
  /** Refuses to submit while the text is blank. */
  required?: boolean;
};

type Pending =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void };

type DialogValue = {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
};

const DialogContext = React.createContext<DialogValue>({
  confirm: async () => false,
  prompt: async () => null,
});

export function useDialog(): DialogValue {
  return React.useContext(DialogContext);
}

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [text, setText] = useState('');

  // The dialog currently on screen, mirrored where a handler can settle its
  // promise. Written in an effect rather than during render: React Compiler
  // forbids the latter, and under concurrent rendering a render that gets
  // thrown away would have written it anyway.
  const openRef = useRef<Pending | null>(null);
  useEffect(() => {
    openRef.current = pending;
  }, [pending]);

  const close = useCallback((settle: (p: Pending) => void) => {
    const current = openRef.current;
    if (!current) return;
    openRef.current = null;
    setPending(null);
    setText('');
    settle(current);
  }, []);

  const cancel = useCallback(() => {
    close((p) => (p.kind === 'confirm' ? p.resolve(false) : p.resolve(null)));
  }, [close]);

  const accept = useCallback((value: string) => {
    close((p) => (p.kind === 'confirm' ? p.resolve(true) : p.resolve(value)));
  }, [close]);

  // Asking a second question while the first is still up would strand the first
  // promise for ever, and an await that never settles is a screen that is stuck
  // with no way to tell why.
  const replace = useCallback((next: Pending) => {
    const previous = openRef.current;
    if (previous) {
      if (previous.kind === 'confirm') previous.resolve(false);
      else previous.resolve(null);
    }
    openRef.current = next;
    setPending(next);
  }, []);

  const value = useMemo<DialogValue>(() => ({
    confirm: (options) => new Promise<boolean>((resolve) => {
      setText('');
      replace({ kind: 'confirm', options, resolve });
    }),
    prompt: (options) => new Promise<string | null>((resolve) => {
      setText(options.initialValue ?? '');
      replace({ kind: 'prompt', options, resolve });
    }),
  }), [replace]);

  // Escape closes, Enter confirms — the reflexes on a desktop, which is where
  // most of BLUP is used.
  useEffect(() => {
    if (Platform.OS !== 'web' || !pending) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
      if (event.key === 'Enter' && pending.kind === 'confirm') accept('');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, cancel, accept]);

  const options = pending?.options;
  const blocked = pending?.kind === 'prompt'
    && Boolean((pending.options as PromptOptions).required)
    && text.trim().length === 0;

  return (
    <DialogContext.Provider value={value}>
      {children}
      <Modal
        visible={pending !== null}
        transparent
        animationType="fade"
        onRequestClose={cancel}
        statusBarTranslucent
      >
        <Pressable style={styles.backdrop} onPress={cancel} accessibilityLabel="Zavrieť">
          {/* Swallows taps inside the card so only the backdrop closes. */}
          <Pressable style={styles.card} onPress={() => {}}>
            <Text style={styles.title}>{options?.title}</Text>
            {options?.body ? <Text style={styles.body}>{options.body}</Text> : null}

            {pending?.kind === 'prompt' ? (
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder={(pending.options as PromptOptions).placeholder}
                placeholderTextColor={colors.textTertiary}
                multiline={(pending.options as PromptOptions).multiline}
                autoFocus
                style={[
                  styles.input,
                  (pending.options as PromptOptions).multiline && styles.inputMultiline,
                ]}
                onSubmitEditing={() => { if (!blocked) accept(text); }}
              />
            ) : null}

            <View style={styles.actions}>
              <Pressable onPress={cancel} style={[styles.button, styles.buttonGhost]}>
                <Text style={styles.buttonGhostLabel}>{options?.cancelLabel ?? 'Zrušiť'}</Text>
              </Pressable>
              <Pressable
                onPress={() => accept(text)}
                disabled={blocked}
                style={[
                  styles.button,
                  options?.destructive ? styles.buttonDanger : styles.buttonPrimary,
                  blocked && styles.buttonDisabled,
                ]}
              >
                <Text style={styles.buttonLabel}>{options?.confirmLabel ?? 'Potvrdiť'}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </DialogContext.Provider>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(4,6,10,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  title: { ...typography.subheading, color: colors.text },
  body: { ...typography.body, color: colors.textSecondary },

  input: {
    marginTop: spacing.xs,
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    ...typography.body,
  },
  inputMultiline: { minHeight: 90, textAlignVertical: 'top' },

  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  button: {
    flex: 1,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonGhost: { backgroundColor: colors.surfaceElevated },
  buttonPrimary: { backgroundColor: colors.accent },
  buttonDanger: { backgroundColor: colors.danger },
  buttonDisabled: { opacity: 0.5 },
  buttonLabel: { ...typography.bodyStrong, color: '#FFFFFF' },
  buttonGhostLabel: { ...typography.bodyStrong, color: colors.textSecondary },
});
