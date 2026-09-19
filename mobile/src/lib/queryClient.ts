import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient } from '@tanstack/react-query';

/**
 * The one query client, in its own module so it can be reached from outside
 * React.
 *
 * It used to live inside app/_layout.tsx, which meant nothing but a component
 * could touch it — and the one thing that badly needed to was signing out.
 */
export const QUERY_CACHE_KEY = 'blup-query-cache';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Keep answers for a day so the offline agenda has something to show.
      gcTime: 24 * 60 * 60 * 1000,
      retry: (failureCount, error) => {
        // Never retry an authorization failure — it will never succeed.
        const message = (error as Error)?.message ?? '';
        if (message.includes('NOT_AUTHORIZED') || message.includes('UNAUTHENTICATED')) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Throws away everything the last person's session put in the cache.
 *
 * This is not tidiness, it is the difference between two people sharing a
 * browser and one of them seeing the other's basket. The cache is written to
 * device storage so the agenda works offline, which means signing out without
 * clearing it leaves the previous account's answers on disk — and the first
 * render after signing out draws them: "mám v košíku 3 vstupenky" on a fresh
 * anonymous session that added nothing.
 *
 * Both halves matter. `clear()` empties what is in memory; removing the stored
 * copy stops the persister putting it straight back on the next launch.
 */
export async function clearCachedUserData(): Promise<void> {
  queryClient.clear();
  try {
    await AsyncStorage.removeItem(QUERY_CACHE_KEY);
  } catch {
    // Storage that refuses to co-operate must not stop somebody signing out.
  }
}
