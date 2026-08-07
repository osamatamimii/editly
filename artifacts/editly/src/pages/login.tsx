import { useState } from "react";
import { useLocation } from "wouter";
import { Loader2, Mail, Lock, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";

type Mode = "signin" | "signup";

export default function Login() {
  const [, setLocation] = useLocation();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setIsSubmitting(true);

    try {
      if (mode === "signup") {
        const { data, error: signUpError } = await supabase.auth.signUp({ email, password });
        if (signUpError) throw signUpError;

        // With email confirmation enabled Supabase returns a user but no
        // session — the account exists but cannot act until the link is used.
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

      <button
        onClick={() => setLocation("/")}
        className="mb-8 flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        data-testid="link-back-home"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to home
      </button>

      <div className="flex items-center gap-2 mb-8">
        <img src="/logo.png" alt="Editly" className="w-10 h-10" />
        <span className="font-bold text-xl tracking-tight">Editly</span>
      </div>

      <Card className="glass-panel border-white/10 w-full max-w-md">
        <CardContent className="pt-8 pb-8">
          <h1 className="text-2xl font-bold mb-1 text-center">
            {mode === "signin" ? "Welcome back" : "Create your account"}
          </h1>
          <p className="text-sm text-muted-foreground mb-8 text-center">
            {mode === "signin"
              ? "Sign in to pick up where you left off."
              : "Start turning raw footage into viral clips."}
          </p>

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
                  className="pl-10 bg-white/5 border-white/10"
                  required
                  autoComplete="email"
                  data-testid="input-email"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === "signup" ? "At least 6 characters" : "Your password"}
                  className="pl-10 bg-white/5 border-white/10"
                  required
                  minLength={6}
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  data-testid="input-password"
                />
              </div>
            </div>

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
              {mode === "signin" ? "Sign in" : "Create account"}
            </Button>
          </form>

          <p className="text-sm text-muted-foreground text-center mt-6">
            {mode === "signin" ? "New to Editly?" : "Already have an account?"}{" "}
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
