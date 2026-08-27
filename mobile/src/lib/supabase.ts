import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

import { env, isConfigured } from './env';

/**
 * The single Supabase client for the app.
 *
 * Sessions are persisted with AsyncStorage and refreshed automatically while the
 * app is in the foreground. `detectSessionInUrl` is off because React Native has
 * no URL bar — OAuth callbacks are handled explicitly in src/auth/oauth.ts.
 *
 * Note on storage choice: Supabase sessions exceed SecureStore's 2 KB warning
 * threshold on Android, so AsyncStorage is used. The token is short-lived and
 * scoped by RLS; see SECURITY notes in ARCHITECTURE.md.
 */

/**
 * The web build pre-renders every route in Node, where there is no `window` and
 * therefore no storage at all. AsyncStorage reaches for localStorage on web, so
 * without this the whole export dies on "window is not defined".
 *
 * Returning nothing during pre-render is not a workaround, it is correct: a
 * build machine has no session, and pretending otherwise would bake one
 * person's logged-in HTML into a file served to everybody. The real session
 * loads on hydration, in the browser, where storage exists.
 */
const isServerRender = typeof window === 'undefined';

const sessionStorage = isServerRender
  ? {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    }
  : AsyncStorage;

export const supabase: SupabaseClient = createClient(
  env.supabaseUrl || 'http://localhost-not-configured',
  env.supabaseAnonKey || 'not-configured',
  {
    auth: {
      storage: sessionStorage,
      autoRefreshToken: !isServerRender,
      persistSession: !isServerRender,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
    global: {
      headers: { 'x-blup-client': 'mobile' },
    },
    realtime: {
      params: { eventsPerSecond: 5 },
    },
  },
);

// Refreshing only matters while the app is visible; stopping in the background
// avoids pointless network wake-ups and battery drain.
if (isConfigured.supabase && !isServerRender) {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      void supabase.auth.startAutoRefresh();
    } else {
      void supabase.auth.stopAutoRefresh();
    }
  });
}

/** Base URL for Edge Functions, derived from the project URL. */
export function functionsUrl(name: string): string {
  return `${env.supabaseUrl}/functions/v1/${name}`;
}

/**
 * Calls an Edge Function with the current session. Returns a typed result and
 * turns backend error envelopes into thrown ApiErrors so screens can render
 * a real message rather than a generic failure.
 */
export async function callFunction<T>(
  name: string,
  body?: unknown,
  options: { method?: 'POST' | 'GET' } = {},
): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, {
    method: options.method ?? 'POST',
    body: body as Record<string, unknown> | undefined,
  });

  if (error) {
    // supabase-js wraps non-2xx responses; dig out our { error: { code } } shape.
    const context = (error as { context?: Response }).context;
    if (context && typeof context.json === 'function') {
      try {
        const payload = await context.json();
        if (payload?.error?.code) {
          throw new FunctionError(payload.error.code, payload.error.message, context.status);
        }
      } catch (parseError) {
        if (parseError instanceof FunctionError) throw parseError;
      }
    }
    // supabase-js says "Failed to send a request to the Edge Function" when the
    // request never completed at all — the function is not deployed (its
    // preflight 404s without CORS headers, so the browser blocks it), or the
    // project URL points somewhere else. Carry the name: the next person to
    // read this error should not have to guess which function it was.
    if (/failed to send a request/i.test(error.message ?? '')) {
      throw new FunctionError('FUNCTION_UNREACHABLE', name, 0);
    }

    throw new FunctionError('FUNCTION_ERROR', error.message, 500);
  }

  return data as T;
}

export class FunctionError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'FunctionError';
  }
}
