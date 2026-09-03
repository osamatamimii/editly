/**
 * The screen a recovery link lands on.
 *
 * Until this existed, forgetting a password meant losing the account. The
 * login screen offered sign-in, sign-up and two providers, and nothing else:
 * no "forgot password", no route for a recovery link to arrive at, and no way
 * to set a new one. Supabase would have sent the mail happily; there was
 * nowhere for the link to go.
 *
 * It is the failure with no error message anywhere. Nothing throws, no log
 * line is written, and the only symptom is a person who stops signing in. For
 * a paid product that is a cancelled subscription nobody can attribute.
 *
 * ## How the session gets here
 *
 * Supabase puts the recovery token in the URL fragment, and the client is
 * created with `detectSessionInUrl`, so by the time this component mounts the
 * SDK has usually already exchanged it for a session and stripped the
 * fragment. "Usually" is doing real work in that sentence: the exchange is
 * asynchronous and this page can render first, which is why the session is
 * waited for rather than read once. Reading it once is how this screen would
 * tell somebody with a perfectly good link that it had expired.
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Loader2, Lock } from "lucide-react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import { useLanguage } from "@/lib/language";
import { RESET } from "@/lib/copy/login";

/** Supabase's own floor. Stated on the field rather than discovered on submit. */
const MIN_PASSWORD = 6;

type State = "waiting" | "ready" | "expired" | "done";

export default function ResetPassword() {
  const { t, fmt } = useLanguage();
  const [, setLocation] = useLocation();
  const [state, setState] = useState<State>("waiting");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  /*
    Wait for the exchange rather than reading the session once.

    `onAuthStateChange` fires `PASSWORD_RECOVERY` when the SDK finishes with the
    fragment, and `getSession` covers the case where it had already finished
    before this mounted. Without the listener, a slower exchange renders "this
    link has expired" over a link that is perfectly good, and the person gives
    up on an account they could have had back.
  */
  useEffect(() => {
    let live = true;

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (live && session) setState("ready");
    });

    supabase.auth.getSession().then(({ data }) => {
      if (!live) return;
      if (data.session) setState("ready");
      // Long enough for the fragment exchange, short enough that a real dead
      // link does not leave somebody watching a spinner.
      else setTimeout(() => { if (live) setState((s) => (s === "waiting" ? "expired" : s)); }, 2500);
    });

    return () => {
      live = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Checked here as well as by the field, because a paste into one box and
    // a typo in the other is the whole reason there are two.
    if (password !== confirmation) {
      setError(t(RESET.notTheSame));
      return;
    }

    setIsSubmitting(true);
    try {
      const { error: failed } = await supabase.auth.updateUser({ password });
      if (failed) throw failed;
      setState("done");
      // Straight in. They have just proved they hold the address and chosen a
      // password; asking them to sign in with it immediately is a step that
      // exists only to be tidy.
      setTimeout(() => setLocation("/dashboard"), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : t(RESET.couldNotSet));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center px-6 py-12">
      <div className="flex items-center gap-2.5 mb-8">
        <Logo className="w-8 h-8 text-brand-mark" />
        <span className="font-bold text-xl tracking-tight">Editly</span>
      </div>

      <Card className="glass-panel border-hairline w-full max-w-md">
        <CardContent className="pt-8 pb-8">
          {state === "waiting" && (
            <div className="flex flex-col items-center gap-3 py-6" data-testid="state-reset-waiting">
              <Loader2 className="w-5 h-5 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">{t(RESET.checking)}</p>
            </div>
          )}

          {state === "expired" && (
            <div className="text-center" data-testid="state-reset-expired">
              <h1 className="text-2xl font-bold mb-2">{t(RESET.expiredTitle)}</h1>
              <p className="text-sm text-muted-foreground mb-6">{t(RESET.expiredLead)}</p>
              <Button
                className="w-full h-12 rounded-xl btn-gradient-cta text-white font-semibold"
                onClick={() => setLocation("/login?mode=reset")}
                data-testid="button-request-new-link"
              >
                {t(RESET.sendAnother)}
              </Button>
            </div>
          )}

          {state === "done" && (
            <div className="text-center" data-testid="state-reset-done">
              <h1 className="text-2xl font-bold mb-2">{t(RESET.doneTitle)}</h1>
              <p className="text-sm text-muted-foreground">{t(RESET.doneLead)}</p>
            </div>
          )}

          {state === "ready" && (
            <>
              <h1 className="text-2xl font-bold mb-1 text-center">{t(RESET.chooseTitle)}</h1>
              <p className="text-sm text-muted-foreground mb-8 text-center">{t(RESET.chooseLead)}</p>

              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="new-password">{t(RESET.newPassword)}</Label>
                  <div className="relative">
                    <Lock className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                    <Input
                      id="new-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={fmt(RESET.minChars, MIN_PASSWORD)}
                      className="ps-10 bg-surface-1 border-hairline"
                      required
                      minLength={MIN_PASSWORD}
                      autoComplete="new-password"
                      data-testid="input-new-password"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirm-password">{t(RESET.andAgain)}</Label>
                  <div className="relative">
                    <Lock className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                    <Input
                      id="confirm-password"
                      type="password"
                      value={confirmation}
                      onChange={(e) => setConfirmation(e.target.value)}
                      placeholder={t(RESET.sameOne)}
                      className="ps-10 bg-surface-1 border-hairline"
                      required
                      minLength={MIN_PASSWORD}
                      autoComplete="new-password"
                      data-testid="input-confirm-password"
                    />
                  </div>
                </div>

                {error && (
                  <p className="text-sm text-destructive" role="alert" data-testid="text-reset-error">
                    {error}
                  </p>
                )}

                <Button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full h-12 rounded-xl btn-gradient-cta text-white font-semibold"
                  data-testid="button-set-password"
                >
                  {isSubmitting && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
                  {t(RESET.setIt)}
                </Button>
              </form>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
