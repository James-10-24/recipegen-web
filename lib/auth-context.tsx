import type { Session } from '@supabase/supabase-js';
import { useRouter } from 'expo-router';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { readOnboardingSeen, writeOnboardingSeen } from '@/lib/onboarding';
import {
  configurePurchases,
  loginPurchases,
  logoutPurchases,
} from '@/lib/purchases';
import { supabase } from '@/lib/supabase';

type AuthContextValue = {
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
  /** null while the AsyncStorage flag is loading; boolean once known. */
  onboardingSeen: boolean | null;
  markOnboardingSeen: () => Promise<void>;
  /** "Show intro again" from Settings — clears the flag. */
  resetOnboarding: () => Promise<void>;
  /**
   * True when the current session is anonymous (Supabase guest mode).
   * Anonymous users have a real user_id and can use the app — but a few
   * things are gated: publishing public recipes, setting a display name,
   * etc. Upgrading to a real account preserves all their data.
   */
  isGuest: boolean;
  /**
   * True for the brief window after a user verifies a password-recovery
   * email link. Set automatically by the Supabase `PASSWORD_RECOVERY`
   * auth event AND imperatively from /auth/callback after a successful
   * verifyOtp({ type: 'recovery' }) — belt-and-suspenders so the
   * `/auth/reset` gate can't race the event ordering.
   */
  recoveryActive: boolean;
  /** Set by /auth/callback after verifyOtp({ type: 'recovery' }). */
  markRecoveryActive: () => void;
  /** Clear the recovery flag. Call after a successful updateUser. */
  clearRecovery: () => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [onboardingSeen, setOnboardingSeen] = useState<boolean | null>(null);
  const [recoveryActive, setRecoveryActive] = useState(false);
  const prevSessionRef = useRef<Session | null>(null);

  // Configure RevenueCat once on app mount. Idempotent and fails soft when
  // the API key isn't set (dev environment). Login/logout below re-binds
  // the app_user_id to the active Supabase session.
  useEffect(() => {
    configurePurchases();
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession);
      // PASSWORD_RECOVERY fires after verifyOtp({ type: 'recovery' })
      // succeeds — i.e., the user just clicked a password-reset email.
      // /auth/reset gates on this so a normal session can't reach the
      // "no current-password required" code path.
      if (event === 'PASSWORD_RECOVERY') {
        setRecoveryActive(true);
      } else if (event === 'SIGNED_OUT') {
        setRecoveryActive(false);
      }
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  // When the session transitions from "had one" to "gone" — the user
  // signed out, the JWT expired, or a remote logout fired — redirect
  // explicitly. Without this, screens outside the (tabs) group (Settings,
  // recipe/*, pantry/*) have no auth gate of their own and would just
  // sit with stale data showing.
  //
  // Skip the initial null→null transition (app launch with no session)
  // because the user is already heading to /sign-in via the layout
  // gates; an extra replace would compete with that flow.
  useEffect(() => {
    const prev = prevSessionRef.current;
    if (prev && !session && !loading) {
      router.replace('/sign-in' as any);
    }
    prevSessionRef.current = session;
  }, [session, loading, router]);

  // Sync RevenueCat's app_user_id to the active Supabase user. Anonymous
  // sessions stay on the default (anonymous) RC id since they can't
  // purchase anyway — only real accounts log in to RC.
  useEffect(() => {
    const userId = session?.user?.id;
    const isAnon = session?.user?.is_anonymous === true;
    if (userId && !isAnon) {
      void loginPurchases(userId);
    } else if (!session) {
      void logoutPurchases();
    }
  }, [session?.user?.id, session?.user?.is_anonymous, session]);

  // Independent of auth — onboarding flag lives in local storage and is
  // checked once on mount. Setting it later flips the in-memory state so
  // gates that depend on it re-render immediately.
  useEffect(() => {
    let cancelled = false;
    readOnboardingSeen().then((v) => {
      if (!cancelled) setOnboardingSeen(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  const markOnboardingSeen = async () => {
    await writeOnboardingSeen(true);
    setOnboardingSeen(true);
  };

  const resetOnboarding = async () => {
    await writeOnboardingSeen(false);
    setOnboardingSeen(false);
  };

  const markRecoveryActive = () => setRecoveryActive(true);
  const clearRecovery = () => setRecoveryActive(false);

  return (
    <AuthContext.Provider
      value={{
        session,
        loading,
        signOut,
        onboardingSeen,
        markOnboardingSeen,
        resetOnboarding,
        isGuest: session?.user?.is_anonymous === true,
        recoveryActive,
        markRecoveryActive,
        clearRecovery,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
