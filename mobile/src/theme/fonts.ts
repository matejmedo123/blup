import {
  useFonts,
  Nunito_400Regular,
  Nunito_600SemiBold,
  Nunito_700Bold,
  Nunito_800ExtraBold,
  Nunito_900Black,
} from '@expo-google-fonts/nunito';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_700Bold,
} from '@expo-google-fonts/jetbrains-mono';

/**
 * Loads the two families the design system uses. Nunito carries the full Latin
 * Extended range, which Slovak needs — ľ, ť, ď, ň, ô, č, š, ž all render
 * properly rather than falling back mid-word.
 *
 * Returns false until the fonts are ready; the root layout holds the splash
 * screen until then so text never reflows from a system fallback.
 */
export function useAppFonts(): boolean {
  const [loaded, error] = useFonts({
    Nunito_400Regular,
    Nunito_600SemiBold,
    Nunito_700Bold,
    Nunito_800ExtraBold,
    Nunito_900Black,
    JetBrainsMono_400Regular,
    JetBrainsMono_700Bold,
  });

  // A font that fails to load must not brick the app — fall through to the
  // system face rather than showing a blank screen forever.
  return loaded || Boolean(error);
}
