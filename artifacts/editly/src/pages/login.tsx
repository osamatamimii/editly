import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Loader2, Mail, Lock } from "lucide-react";
import { BackButton } from "@/components/back-button";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import {
  enabledProviders,
  signInWithProvider,
  takeOAuthError,
  ProviderNotEnabledError,
  PROVIDER_LABEL,
  type OAuthProvider,
} from "@/lib/oauth";

type Mode = "signin" | "signup" | "reset";

/**
 * Which form to show first.
 *
 * Read from the URL so the two entry points in the header land somewhere
 * different: "Log in" opens the sign-in form, "Sign up free" opens the
 * account-creation one. Sending both to the same screen and making the new
 * visitor find a small link is how you lose the person who just decided to try
 * the product.
 */
function initialMode(): Mode {
  if (typeof window === "undefined") return "signin";
  const asked = new URLSearchParams(window.location.search).get("mode");
  // `reset` is here so the expired-link screen can send somebody straight back
  // to the form that mails a new one, rather than to a screen where they have
  // to find the small link again.
  return asked === "signup" || asked === "reset" ? asked : "signin";
}

export default function Login() {
  const [, setLocation] = useLocation();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [busyProvider, setBusyProvider] = useState<OAuthProvider | null>(null);
  const [providers, setProviders] = useState<Set<OAuthProvider> | null>(null);

  /**
   * Whatever the provider said on the way back.
   *
   * A failed OAuth redirect lands on `/dashboard`, finds no session, and is
   * redirected here — and the redirect drops the URL that carried the reason.
   * `main.tsx` takes it off the URL before React renders; this is where it is
   * finally read, on the screen the person is actually looking at.
   */
  useEffect(() => {
    const said = takeOAuthError();
    if (said) setError(said);
  }, []);

  // Ask the project which providers are on rather than assuming, so a button
  // is never shown that cannot work.
  useEffect(() => {
    let active = true;
    enabledProviders().then((set) => {
      if (active) setProviders(set);
    });
    return () => {
      active = false;
    };
  }, []);

  const handleProvider = async (provider: OAuthProvider) => {
    setError(null);
    setNotice(null);
    setBusyProvider(provider);
    try {
      await signInWithProvider(provider);
      // On success the browser has already navigated away.
    } catch (err) {
      setError(
        err instanceof ProviderNotEnabledError
          ? `${PROVIDER_LABEL[provider]} sign-in isn't switched on yet. Use your email for now.`
          : err instanceof Error
            ? err.message
            : "Could not start sign-in. Please try again.",
      );
      setBusyProvider(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setIsSubmitting(true);

    try {
      /*
        Forgetting a password used to mean losing the account.

        There was no way to ask for a reset and nowhere for a recovery link to
        land, so the only route back in was a second account and the loss of
        every project in the first. Nothing failed and nothing was logged: the
        symptom is a person who simply stops signing in, which for a paid
        product is a cancellation nobody can attribute.

        The notice is the same sentence whether or not that address has an
        account. Saying "no account with that email" here turns this box into a
        way to test whether somebody uses Editly, one address at a time.
      */
      if (mode === "reset") {
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/reset-password`,
        });
        // A rate limit is worth saying out loud; anything else would leak
        // whether the address is one of ours.
        if (resetError && resetError.status === 429) throw resetError;
        setNotice("If that address has an account, a link is on its way. It lasts an hour.");
        setMode("signin");
        return;
      }

      if (mode === "signup") {
        const { data, error: signUpError } = await supabase.auth.signUp({ email, password });
        if (signUpError) throw signUpError;

        // If the project requires email confirmation, Supabase returns a user
        // but no session: the account exists and cannot act until the link is
        // used. Confirmation is currently off, so this is the path that runs
        // again the moment it is turned back on.
        if (!data.session) {
          setNotice("Check your inbox to confirm your email, then sign in.");
          setMode("signin");
          return;
        }
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
      }

      setLocation("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center px-6 py-12">
      <div className="fixed inset-0 pointer-events-none -z-10 overflow-hidden">
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(ellipse 100% 55% at 50% -5%, rgba(108,59,255,0.4) 0%, rgba(108,59,255,0.12) 40%, transparent 70%)",
          }}
        />
      </div>

      <BackButton fallback="/" label="Back" className="mb-8 -ml-4" testId="link-back-home" />

      <div className="flex items-center gap-2.5 mb-8">
        <Logo className="w-8 h-8 text-brand-mark" />
        <span className="font-bold text-xl tracking-tight">Editly</span>
      </div>

      {/* The line the product is named after, at the moment someone decides
          whether to sign up: it is the whole proposition in four words. */}
      <p className="text-sm text-muted-foreground mb-8 -mt-6" data-testid="text-signature-login">
        Stop editing. Start describing.
      </p>

      <Card className="glass-panel border-hairline w-full max-w-md">
        <CardContent className="pt-8 pb-8">
          <h1 className="text-2xl font-bold mb-1 text-center">
            {mode === "signin"
              ? "Welcome back"
              : mode === "signup"
                ? "Create your account"
                : "Reset your password"}
          </h1>
          <p className="text-sm text-muted-foreground mb-8 text-center">
            {mode === "signin"
              ? "Sign in to pick up where you left off."
              : mode === "signup"
                ? "Start turning raw footage into viral clips."
                : "Tell us the address you signed up with and we will send a link."}
          </p>

          {mode !== "reset" && providers && providers.size > 0 && (
            <div className="space-y-3 mb-6">
              {providers.has("google") && (
                <button
                  type="button"
                  onClick={() => handleProvider("google")}
                  disabled={busyProvider !== null || isSubmitting}
                  className="w-full h-12 rounded-xl bg-white text-[#1f1f1f] border border-hairline font-semibold flex items-center justify-center gap-3 transition-opacity hover:opacity-90 disabled:opacity-50"
                  data-testid="button-google-signin"
                >
                  {busyProvider === "google" ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden="true">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z" />
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
                      <path fill="#FBBC05" d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z" />
                      <path fill="#EA4335" d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.47 14.97.5 12 .5A11 11 0 0 0 2.18 7.05l3.66 2.84c.87-2.6 3.3-4.14 6.16-4.14Z" />
                    </svg>
                  )}
                  Continue with Google
                </button>
              )}

              {providers.has("apple") && (
                <button
                  type="button"
                  onClick={() => handleProvider("apple")}
                  disabled={busyProvider !== null || isSubmitting}
                  className="w-full h-12 rounded-xl bg-black text-white border border-hairline-strong font-semibold flex items-center justify-center gap-3 transition-opacity hover:opacity-90 disabled:opacity-50"
                  data-testid="button-apple-signin"
                >
                  {busyProvider === "apple" ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M17.05 12.54c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.61-1.7-3.18-1.72-1.35-.14-2.64.79-3.33.79-.68 0-1.74-.77-2.86-.75-1.47.02-2.83.85-3.59 2.17-1.53 2.65-.39 6.58 1.1 8.73.73 1.05 1.6 2.23 2.74 2.19 1.1-.04 1.52-.71 2.85-.71 1.33 0 1.7.71 2.86.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.4 1.2-2.46-.03-.01-2.3-.88-2.32-3.49ZM14.88 5.6c.6-.73 1.01-1.75.9-2.76-.87.04-1.92.58-2.55 1.31-.56.65-1.05 1.68-.92 2.67.97.08 1.96-.49 2.57-1.22Z" />
                    </svg>
                  )}
                  Continue with Apple
                </button>
              )}

              <div className="flex items-center gap-3 pt-1">
                <div className="h-px flex-1 bg-surface-2" />
                <span className="text-xs text-muted-foreground">or with email</span>
                <div className="h-px flex-1 bg-surface-2" />
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="pl-10 bg-surface-1 border-hairline"
                  required
                  autoComplete="email"
                  data-testid="input-email"
                />
              </div>
            </div>

            {mode !== "reset" && (
              <div className="space-y-2">
                {/* The row keeps its height from the label, and the link keeps
                    a thumb's width of its own: `min-h-11` with a matching
                    negative margin, so it is tappable on a phone without
                    pushing the field down. */}
                <div className="flex items-center justify-between min-h-5">
                  <Label htmlFor="password">Password</Label>
                  {mode === "signin" && (
                    <button
                      type="button"
                      onClick={() => {
                        setMode("reset");
                        setError(null);
                        setNotice(null);
                      }}
                      className="text-xs text-primary hover:underline min-h-11 md:min-h-0 -my-3 md:my-0 px-2 -mx-2 inline-flex items-center"
                      data-testid="button-forgot-password"
                    >
                      Forgot it?
                    </button>
                  )}
                </div>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === "signup" ? "At least 6 characters" : "Your password"}
                    className="pl-10 bg-surface-1 border-hairline"
                    required
                    minLength={6}
                    autoComplete={mode === "signup" ? "new-password" : "current-password"}
                    data-testid="input-password"
                  />
                </div>
              </div>
            )}

            {error && (
              <p className="text-sm text-destructive" role="alert" data-testid="text-auth-error">
                {error}
              </p>
            )}
            {notice && (
              <p className="text-sm text-primary" role="status" data-testid="text-auth-notice">
                {notice}
              </p>
            )}

            <Button
              type="submit"
              disabled={isSubmitting}
              className="w-full h-12 rounded-xl btn-gradient-cta text-white font-semibold"
              data-testid="button-submit-auth"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Send the link"}
            </Button>

            {/*
              The two documents, at the moment somebody agrees to them.

              This screen did not contain the words terms, privacy, agree or
              consent anywhere. Both pages existed and were linked from the
              marketing footer, which is not where an account is created, so
              nobody who signed up had been shown either. That leaves the
              liability cap, the refund terms and every processor in the privacy
              policy resting on a document the customer never met.

              A line under the button rather than a checkbox, because a checkbox
              that everyone ticks without reading is not more consent, it is one
              more thing between a person and the product. What matters is that
              the words are on the screen where the account is made, and that
              both links open.
            */}
            {mode === "signup" && (
              <p className="text-xs text-muted-foreground text-center" data-testid="text-signup-terms">
                By creating an account you agree to our{" "}
                <a href="/terms" className="text-primary hover:underline" data-testid="link-terms">
                  Terms
                </a>{" "}
                and{" "}
                <a href="/privacy" className="text-primary hover:underline" data-testid="link-privacy">
                  Privacy Policy
                </a>
                . Editly is for people aged 16 and over.
              </p>
            )}
          </form>

          <p className="text-sm text-muted-foreground text-center mt-6">
            {mode === "signin" ? "New to Editly?" : mode === "signup" ? "Already have an account?" : "Remembered it?"}{" "}
            <button
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setError(null);
                setNotice(null);
              }}
              className="text-primary hover:underline font-medium"
              data-testid="button-toggle-auth-mode"
            >
              {mode === "signin" ? "Create an account" : "Sign in"}
            </button>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
