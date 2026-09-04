import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session, User } from "@supabase/supabase-js";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import { supabase } from "./supabase";

type AuthState = {
  user: User | null;
  session: Session | null;
  /** True until the initial session lookup finishes, so we never flash the login screen at a signed-in user. */
  isLoading: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

/**
 * Hands the API client a function that returns the current access token.
 *
 * Reading the token at call time (rather than capturing it once) matters:
 * Supabase rotates the access token roughly hourly, and a captured value would
 * start returning 401s the moment it expires.
 */
setAuthTokenGetter(async () => {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const queryClient = useQueryClient();
  /** Whose data is in the cache. Null before anybody has signed in here. */
  const cachedFor = useRef<string | null>(null);

  useEffect(() => {
    let active = true;

    /*
      The cache belongs to whoever was signed in, and it was outliving them.

      There is one `QueryClient` for the app's lifetime, every key is a path
      with no user in it — `["/api/projects"]`, `["/api/subscription"]` — and
      both sign-in and sign-out are client-side navigations with no document
      reload. So on a shared browser, the second person to sign in mounted the
      dashboard against the first person's cached projects and rendered them
      while the refetch was in flight: their titles, their dates, their plan.

      Nothing failed. It resolves itself a round trip later, and clicking one of
      those cards lands on "Project not found" — which reads as a bug in the
      product rather than as somebody else's library. And `accountIsNew` on the
      dashboard is computed from that same cached list, so a genuinely new
      account skipped the first-run screen entirely.

      Cleared on any change of identity, which covers signing out, signing in as
      somebody else, and the recovery link that swaps the session underneath a
      page that is already open.
    */
    const forget = (next: Session | null) => {
      const who = next?.user?.id ?? null;
      if (cachedFor.current !== null && cachedFor.current !== who) {
        queryClient.clear();
      }
      cachedFor.current = who;
    };

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      forget(data.session);
      setSession(data.session);
      setIsLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => {
      forget(next);
      setSession(next);
      setIsLoading(false);
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, [queryClient]);

  const value: AuthState = {
    user: session?.user ?? null,
    session,
    isLoading,
    signOut: async () => {
      await supabase.auth.signOut();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
