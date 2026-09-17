import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';
import { claimMyGuestTickets } from '@/api/tickets';
import { isConfigured } from '@/lib/env';
import type { Profile } from '@/types/models';

interface AuthState {
  session: Session | null;
  user: Session['user'] | null;
  profile: Profile | null;
  /** True until the persisted session has been restored from storage. */
  initializing: boolean;
  /** True while the profile row is being (re)loaded. */
  loadingProfile: boolean;
  isAuthenticated: boolean;
  /**
   * Nobody is signed in. Not an error state: a visitor can browse events,
   * open one, search and look at profiles without an account. The account is
   * asked for at the moment it is actually needed — buying, going, writing.
   */
  isGuest: boolean;
  isAdmin: boolean;
  /**
   * A full admin, not a moderator.
   *
   * `isAdmin` covers both, because a moderator does most of what an admin does
   * to content. The few things that are BLUP speaking as itself — putting our
   * name on somebody else's event — ask for this one instead.
   */
  isFullAdmin: boolean;
  needsOnboarding: boolean;
  backendConfigured: boolean;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  // False from the start when there is no backend to restore a session from —
  // otherwise the app showed a splash for a state that was never going to
  // arrive, and the effect had to correct it on the next tick.
  const [initializing, setInitializing] = useState(() => isConfigured.supabase);
  const [loadingProfile, setLoadingProfile] = useState(false);

  const loadProfile = useCallback(async (userId: string) => {
    setLoadingProfile(true);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (error) throw error;
      setProfile((data as Profile) ?? null);
    } catch (error) {
      // A missing profile is recoverable (the trigger may not have run yet);
      // onboarding will create it. Never block the app on this.
      console.warn('Failed to load profile:', error);
      setProfile(null);
    } finally {
      setLoadingProfile(false);
    }
  }, []);

  useEffect(() => {
    // Nothing to restore without a backend; `initializing` already starts false
    // in that case, so there is no state to correct here.
    if (!isConfigured.supabase) return;

    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (data.session?.user) {
        void loadProfile(data.session.user.id);
      }
      setInitializing(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);

      if (nextSession?.user) {
        void loadProfile(nextSession.user.id);
      } else {
        setProfile(null);
      }

      if (event === 'SIGNED_OUT') {
        setProfile(null);
      }

      // A ticket may have been sent to this address before there was an account
      // to attach it to. The database picks those up when the account is
      // created; this covers the other order — somebody who was already
      // registered when an organizer sent one to their address. It is a no-op
      // when there is nothing waiting, and a failure here must never block a
      // sign-in, so it is deliberately not awaited or surfaced.
      if (event === 'SIGNED_IN' && nextSession?.user) {
        void claimMyGuestTickets().catch(() => {});
      }
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, [loadProfile]);

  // Hoisted out of the dependency array: an optional chain in there is opaque to
  // the compiler, which then gives up on memoizing this callback at all.
  const user = session?.user ?? null;

  const refreshProfile = useCallback(async () => {
    if (user) await loadProfile(user.id);
  }, [user, loadProfile]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setSession(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      session,
      user,
      profile,
      initializing,
      loadingProfile,
      isAuthenticated: Boolean(user),
      isGuest: !user,
      isAdmin: profile?.app_role === 'admin' || profile?.app_role === 'moderator',
      isFullAdmin: profile?.app_role === 'admin',
      // A signed-in user without a completed profile goes through onboarding.
      needsOnboarding: Boolean(user) && profile !== null && !profile.onboarding_completed,
      backendConfigured: isConfigured.supabase,
      refreshProfile,
      signOut,
    }),
    [session, user, profile, initializing, loadingProfile, refreshProfile, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return context;
}
