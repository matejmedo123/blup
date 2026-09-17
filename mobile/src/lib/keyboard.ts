import { Platform } from 'react-native';

/**
 * Enter sends, Shift+Enter makes a new line.
 *
 * A multiline TextInput is a <textarea> in a browser, where Enter has always
 * meant "new line" — so in chat the message sat there until somebody found the
 * ↑ button, and under a comment the same. react-native-web does wire Enter to
 * onSubmitEditing, but only when `blurOnSubmit` is on, and that also blurs the
 * field: you would be clicking back into it before every message.
 *
 * Taking the key ourselves avoids both. react-native-web calls onKeyPress from
 * its keydown handler before its own Enter handling and then checks
 * `isDefaultPrevented()`, so preventing the default here stops the newline and
 * stops it from acting twice.
 *
 * On a phone Enter stays a new line — the send button is under your thumb, and
 * a keyboard that sends on Enter is the wrong default on a touch screen.
 */
type WebKeyEvent = {
  key?: string;
  shiftKey?: boolean;
  preventDefault?: () => void;
  nativeEvent?: { key?: string; shiftKey?: boolean; isComposing?: boolean };
};

export function enterSubmits(submit: () => void) {
  if (Platform.OS !== 'web') return {};

  return {
    onKeyPress: (event: unknown) => {
      const e = event as WebKeyEvent;
      const key = e.key ?? e.nativeEvent?.key;
      const shift = e.shiftKey ?? e.nativeEvent?.shiftKey ?? false;

      // Mid-composition Enter belongs to the input method — it is choosing an
      // accented letter, not sending a message. Sending there would swallow
      // the character and post half a word.
      if (e.nativeEvent?.isComposing) return;
      if (key !== 'Enter' || shift) return;

      e.preventDefault?.();
      submit();
    },
  };
}
