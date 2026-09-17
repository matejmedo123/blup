import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * The invite code somebody arrived with, kept until they have an account.
 *
 * An invite link is opened by a person who does not have an account yet — that
 * is the entire point of it — so the code cannot be applied where it lands. It
 * waits here through the sign-up and the e-mail confirmation, and the invite
 * screen picks it up on the other side.
 *
 * AsyncStorage rather than a route param because the road between the two is
 * not one hop: sign-up, a mail client, a confirmation link, onboarding. A param
 * does not survive any of that.
 */
const KEY = 'blup.pending-invite';

export async function rememberInvite(code: string): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, code.trim().toUpperCase());
  } catch {
    // A browser with storage blocked, a full disk. The code is a convenience;
    // it is also typeable by hand on the invite screen, so losing it is not
    // worth an error message about something the person did not do.
  }
}

export async function takePendingInvite(): Promise<string | null> {
  try {
    const code = await AsyncStorage.getItem(KEY);
    return code && code.length > 0 ? code : null;
  } catch {
    return null;
  }
}

export async function forgetInvite(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // Same as above: nothing here is worth interrupting anybody for.
  }
}
