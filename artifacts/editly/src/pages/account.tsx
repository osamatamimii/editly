import { useState } from "react";
import { useLocation } from "wouter";
import { useGetSubscription } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { BackButton } from "@/components/back-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { loadState } from "@/lib/load-state";
import { LoadFailed } from "@/components/load-failed";
import { Loader2, LogOut, Mail, KeyRound, Trash2 } from "lucide-react";

/**
 * The account screen.
 *
 * Every other page here is about making a video. This one is about the four
 * things a person needs to be able to do to a service they pay for and none of
 * which existed: see what they are on, change how they sign in, stop paying,
 * and leave.
 *
 * The last of those is the reason this page is worth building carefully. A
 * product with no delete button is one you have to email to escape, and that is
 * a decision about the customer's leverage rather than about engineering
 * effort. It is here, it is real, and it says exactly what it will do before it
 * does it.
 */
export default function AccountPage() {
  const [, setLocation] = useLocation();
  const { user, signOut } = useAuth();
  const { toast } = useToast();
  const subscriptionQuery = useGetSubscription();
  const { data: subscription } = subscriptionQuery;
  // A plan card that shows nothing when the read failed leaves someone unsure
  // whether they are on the tier they paid for.
  const subscriptionState = loadState(subscriptionQuery);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState<null | "email" | "password" | "delete">(null);

  const changeEmail = async () => {
    const next = email.trim();
    if (!next || next === user?.email) return;
    setBusy("email");
    const { error } = await supabase.auth.updateUser({ email: next });
    setBusy(null);
    if (error) {
      toast({ title: "Could not change your email", description: error.message, variant: "destructive" });
      return;
    }
    setEmail("");
    // Both addresses, because Supabase asks the old one to approve the change
    // and the new one to prove it exists — and a person who only checks one of
    // them will otherwise think nothing happened.
    toast({
      title: "Check both inboxes",
      description: `We've sent a confirmation to ${next} and to your current address. The change takes effect once both are confirmed.`,
    });
  };

  const changePassword = async () => {
    if (password.length < 8) {
      toast({
        title: "That password is too short",
        description: "Eight characters is the minimum. Longer is better than complicated.",
        variant: "destructive",
      });
      return;
    }
    setBusy("password");
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(null);
    if (error) {
      toast({ title: "Could not change your password", description: error.message, variant: "destructive" });
      return;
    }
    setPassword("");
    toast({ title: "Password changed", description: "You'll use the new one next time you sign in." });
  };

  const deleteAccount = async () => {
    setBusy("delete");
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const response = await fetch("/api/account", {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; note?: string };

      if (!response.ok) {
        setBusy(null);
        toast({
          title: "Nothing was deleted",
          description: body.error ?? "Something went wrong on our side. Your account is untouched.",
          variant: "destructive",
        });
        return;
      }

      toast({
        title: "Your account is gone",
        description: body.note ?? "Everything you uploaded has been removed. Thanks for trying it.",
      });
      await signOut();
      setLocation("/");
    } catch {
      setBusy(null);
      toast({
        title: "Nothing was deleted",
        description: "We couldn't reach the server. Your account is untouched.",
        variant: "destructive",
      });
    }
  };

  const canDelete = confirmText.trim().toLowerCase() === "delete my account";

  return (
    <div className="w-full max-w-3xl mx-auto px-6 py-12">
      <div className="flex items-start justify-between gap-4 mb-10">
        <div className="flex items-start gap-2">
          <BackButton fallback="/dashboard" className="-ml-3 mt-1" />
          <div>
            <h1 className="text-3xl font-bold tracking-tight glow-text mb-2">Account</h1>
            <p className="text-muted-foreground" data-testid="text-account-email">
              {user?.email ?? "Signed in"}
            </p>
          </div>
        </div>
        <ThemeToggle />
      </div>

      <div className="flex flex-col gap-6">
        {/* ── What you're on ─────────────────────────────────────────────── */}
        <Card className="glass-panel border-hairline">
          <CardHeader>
            <CardTitle>Your plan</CardTitle>
            <CardDescription>Minutes of finished video, not videos. Uploading is unlimited.</CardDescription>
          </CardHeader>
          <CardContent>
            {subscriptionState === "failed" ? (
              <LoadFailed
                what="your plan and usage"
                compact
                onRetry={() => subscriptionQuery.refetch()}
                testId="account-subscription-failed"
              />
            ) : !subscription ? (
              <Skeleton className="h-24 w-full rounded-xl" />
            ) : (
              <>
                <div className="flex items-baseline justify-between gap-4 mb-4">
                  <span className="text-2xl font-bold capitalize" data-testid="text-plan-name">
                    {subscription.plan}
                  </span>
                  <span className="text-muted-foreground">
                    {subscription.pricePerMonth === 0 ? "Free" : `$${subscription.pricePerMonth}/month`}
                  </span>
                </div>

                <div className="h-2 rounded-full bg-surface-2 overflow-hidden mb-2">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{
                      width: `${Math.min(100, (subscription.minutesUsedThisMonth / Math.max(1, subscription.minutesIncluded)) * 100)}%`,
                    }}
                    data-testid="bar-account-usage"
                  />
                </div>
                <p className="text-sm text-muted-foreground mb-6">
                  {subscription.minutesUsedThisMonth} of {subscription.minutesIncluded} minutes this month
                  {" · "}
                  up to {subscription.maxUploadMinutes} minutes in a single upload
                  {subscription.watermark ? " · renders carry the Editly mark" : ""}
                </p>

                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="outline"
                    className="border-hairline"
                    onClick={() => { window.location.href = "/#pricing"; }}
                    data-testid="button-change-plan"
                  >
                    Change plan
                  </Button>
                  {/* Billing lives at Freemius: they took the payment, they hold
                      the invoices, and they are the only ones who can cancel a
                      subscription. Sending people there is honest; a cancel
                      button here that only downgraded our own row would leave
                      them still being charged. */}
                  <Button
                    variant="outline"
                    className="border-hairline"
                    onClick={() => window.open("https://users.freemius.com/", "_blank", "noopener")}
                    data-testid="button-billing"
                  >
                    Invoices and cancellation
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* ── How you sign in ────────────────────────────────────────────── */}
        <Card className="glass-panel border-hairline">
          <CardHeader>
            <CardTitle>Signing in</CardTitle>
            <CardDescription>Change the address or the password on this account.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <Label htmlFor="account-email" className="flex items-center gap-2 text-sm">
                <Mail className="w-3.5 h-3.5" /> New email address
              </Label>
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  id="account-email"
                  type="email"
                  autoComplete="email"
                  placeholder={user?.email ?? "you@example.com"}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  data-testid="input-new-email"
                />
                <Button
                  variant="outline"
                  className="border-hairline flex-shrink-0"
                  disabled={busy !== null || !email.trim()}
                  onClick={changeEmail}
                  data-testid="button-change-email"
                >
                  {busy === "email" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Send confirmation"}
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="account-password" className="flex items-center gap-2 text-sm">
                <KeyRound className="w-3.5 h-3.5" /> New password
              </Label>
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  id="account-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  data-testid="input-new-password"
                />
                <Button
                  variant="outline"
                  className="border-hairline flex-shrink-0"
                  disabled={busy !== null || password.length === 0}
                  onClick={changePassword}
                  data-testid="button-change-password"
                >
                  {busy === "password" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Change password"}
                </Button>
              </div>
            </div>

            <div>
              <Button
                variant="outline"
                className="border-hairline"
                onClick={async () => {
                  await signOut();
                  setLocation("/");
                }}
                data-testid="button-sign-out"
              >
                <LogOut className="w-4 h-4 mr-2" />
                Sign out
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── Leaving ────────────────────────────────────────────────────── */}
        <Card className="glass-panel border-destructive/30">
          <CardHeader>
            <CardTitle className="text-destructive">Delete this account</CardTitle>
            <CardDescription>
              Every project, every upload and every render, removed for good. This cannot be undone and
              there is no copy kept.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              If you pay for a plan, cancel it first at{" "}
              <button
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => window.open("https://users.freemius.com/", "_blank", "noopener")}
              >
                your billing page
              </button>
              . Deleting here removes your videos; it does not stop a subscription somebody else is
              holding the card details for.
            </p>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirm-delete" className="text-sm">
                Type <span className="font-mono text-foreground">delete my account</span> to confirm
              </Label>
              <Input
                id="confirm-delete"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="delete my account"
                data-testid="input-confirm-delete"
              />
            </div>

            <div>
              <Button
                className="bg-destructive-fill text-white hover:bg-destructive-fill/90"
                disabled={!canDelete || busy !== null}
                onClick={deleteAccount}
                data-testid="button-delete-account"
              >
                {busy === "delete" ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Deleting everything…
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4 mr-2" />
                    Delete my account
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
