import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useGetSubscription } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { BackButton } from "@/components/back-button";
import { ThemeToggle } from "@/components/theme-toggle";
import { LanguageToggle } from "@/components/language-toggle";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { loadState } from "@/lib/load-state";
import { LoadFailed } from "@/components/load-failed";
import {
  SocialConnections,
  type PlatformInfo,
  type ConnectedAccount,
} from "@/components/social-connections";
import { ScheduledPosts } from "@/components/scheduled-posts";
import { apiJson } from "@/lib/api-fetch";
import { useLanguage } from "@/lib/language";
import { ACCOUNT } from "@/lib/copy/account";
import { COMMON, LOAD } from "@/lib/copy/common";
import { Loader2, LogOut, Mail, KeyRound, Trash2, Download } from "lucide-react";

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
  const { t, fmt } = useLanguage();
  const { toast } = useToast();
  const subscriptionQuery = useGetSubscription();
  const { data: subscription } = subscriptionQuery;
  // A plan card that shows nothing when the read failed leaves someone unsure
  // whether they are on the tier they paid for.
  const subscriptionState = loadState(subscriptionQuery);

  /**
   * The connected accounts, read directly rather than through the generated
   * client.
   *
   * Two reads that belong together — what the deployment can post to, and what
   * this person has connected — and a failure in either has the same answer on
   * screen: say the panel could not be read, keep a retry, and do not draw an
   * empty list. An empty list here would say "you have connected nothing",
   * which is a claim about somebody's account made from a network error.
   */
  const [social, setSocial] = useState<{
    state: "loading" | "ready" | "failed";
    platforms: PlatformInfo[];
    accounts: ConnectedAccount[];
  }>({ state: "loading", platforms: [], accounts: [] });

  const loadSocial = useCallback(async () => {
    setSocial((prev) => ({ ...prev, state: "loading" }));
    const [catalogue, mine] = await Promise.all([
      apiJson<{ platforms?: PlatformInfo[] }>("/api/social/platforms"),
      apiJson<{ accounts?: ConnectedAccount[] }>("/api/social/accounts"),
    ]);
    if (!catalogue.ok || !mine.ok) {
      setSocial({ state: "failed", platforms: [], accounts: [] });
      return;
    }
    setSocial({
      state: "ready",
      platforms: catalogue.body.platforms ?? [],
      accounts: mine.body.accounts ?? [],
    });
  }, []);

  useEffect(() => {
    void loadSocial();
  }, [loadSocial]);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState<null | "email" | "password" | "delete" | "export">(null);

  const changeEmail = async () => {
    const next = email.trim();
    if (!next || next === user?.email) return;
    setBusy("email");
    const { error } = await supabase.auth.updateUser({ email: next });
    setBusy(null);
    if (error) {
      toast({ title: t(ACCOUNT.emailFailed), description: error.message, variant: "destructive" });
      return;
    }
    setEmail("");
    // Both addresses, because Supabase asks the old one to approve the change
    // and the new one to prove it exists — and a person who only checks one of
    // them will otherwise think nothing happened.
    toast({
      title: t(ACCOUNT.checkBothInboxes),
      description: fmt(ACCOUNT.checkBothDetail, next),
    });
  };

  const changePassword = async () => {
    if (password.length < 8) {
      toast({
        title: t(ACCOUNT.passwordTooShort),
        description: t(ACCOUNT.passwordTooShortDetail),
        variant: "destructive",
      });
      return;
    }
    setBusy("password");
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(null);
    if (error) {
      toast({ title: t(ACCOUNT.passwordFailed), description: error.message, variant: "destructive" });
      return;
    }
    setPassword("");
    toast({ title: t(ACCOUNT.passwordChanged), description: t(ACCOUNT.passwordChangedDetail) });
  };

  /**
   * Fetches the export and hands it to the browser as a file.
   *
   * Not a plain link, for two reasons that are both about this being an
   * authenticated request. An `<a href="/api/account/export">` sends no bearer
   * token, so it would 401; and the response can take a few seconds to
   * assemble, which a link gives no way to say. So it is fetched, turned into a
   * blob, and saved — and the refusal, when the server cannot list Storage, is
   * shown as a sentence rather than as a downloaded file containing an error.
   */
  const downloadData = async () => {
    setBusy("export");
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const response = await fetch("/api/account/export", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        const said = await response.json().catch(() => null);
        toast({
          title: t(ACCOUNT.exportFailed),
          description: said?.error ?? t(ACCOUNT.exportFailedDetail),
          variant: "destructive",
        });
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `editly-data-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      // Freed on the next tick: revoking before the click has been handled
      // cancels the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast({
        title: t(ACCOUNT.exportFailed),
        description: t(ACCOUNT.exportOffline),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
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
          title: t(ACCOUNT.deleteRefused),
          description: body.error ?? t(ACCOUNT.deleteRefusedDetail),
          variant: "destructive",
        });
        return;
      }

      toast({
        title: t(ACCOUNT.deleted),
        description: body.note ?? t(ACCOUNT.deletedDetail),
      });
      await signOut();
      setLocation("/");
    } catch {
      setBusy(null);
      toast({
        title: t(ACCOUNT.deleteRefused),
        description: t(ACCOUNT.deleteOffline),
        variant: "destructive",
      });
    }
  };

  /*
    Either spelling is accepted, and the label in front of the person is the one
    in their language. A confirmation the screen does not ask for is a form
    somebody is trapped in — which is precisely the moment they were trying to
    leave.
  */
  const confirmations = [ACCOUNT.deleteConfirmPhrase.ar, ACCOUNT.deleteConfirmPhrase.en];
  const canDelete = confirmations.includes(confirmText.trim().toLowerCase());

  return (
    <div className="w-full max-w-3xl mx-auto px-6 py-12">
      <div className="flex items-start justify-between gap-4 mb-10">
        <div className="flex items-start gap-2">
          <BackButton fallback="/dashboard" className="-ms-3 mt-1" />
          <div>
            <h1 className="text-3xl font-bold tracking-tight mb-2">{t(ACCOUNT.title)}</h1>
            {/*
              An address is an address in any language, and the bidi algorithm
              would otherwise move the "@" and the dot to the wrong end of it on
              an Arabic screen. Same reason the prices carry `dir="ltr"`.
            */}
            <p className="text-muted-foreground" dir="ltr" data-testid="text-account-email">
              {user?.email ?? t(ACCOUNT.signedIn)}
            </p>
          </div>
        </div>
        {/* The two settings that are about how the product looks and reads,
            side by side, on the one screen a person goes to to change it. */}
        <div className="flex items-center gap-2">
          <LanguageToggle />
          <ThemeToggle />
        </div>
      </div>

      <div className="flex flex-col gap-6">
        {/* ── What you're on ─────────────────────────────────────────────── */}
        <Card className="glass-panel border-hairline">
          <CardHeader>
            <CardTitle>{t(ACCOUNT.planTitle)}</CardTitle>
            <CardDescription>{t(ACCOUNT.planLead)}</CardDescription>
          </CardHeader>
          <CardContent>
            {subscriptionState === "failed" ? (
              <LoadFailed
                what={ACCOUNT.planFailed}
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
                  <span className="text-muted-foreground" dir={subscription.pricePerMonth === 0 ? undefined : "ltr"}>
                    {subscription.pricePerMonth === 0
                      ? t(ACCOUNT.free)
                      : fmt(ACCOUNT.perMonth, subscription.pricePerMonth)}
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
                  {fmt(ACCOUNT.usage, subscription.minutesUsedThisMonth, subscription.minutesIncluded)}
                  {" · "}
                  {fmt(ACCOUNT.maxUpload, subscription.maxUploadMinutes)}
                  {subscription.watermark ? t(ACCOUNT.watermark) : ""}
                </p>

                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="outline"
                    className="border-hairline"
                    onClick={() => { window.location.href = "/#pricing"; }}
                    data-testid="button-change-plan"
                  >
                    {t(ACCOUNT.changePlan)}
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
                    {t(ACCOUNT.invoices)}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* ── Where your edits go ────────────────────────────────────────── */}
        <Card className="glass-panel border-hairline">
          <CardHeader>
            <CardTitle>{t(ACCOUNT.socialTitle)}</CardTitle>
            <CardDescription>{t(ACCOUNT.socialLead)}</CardDescription>
          </CardHeader>
          <CardContent>
            {social.state === "loading" ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> {t(ACCOUNT.socialReading)}
              </div>
            ) : social.state === "failed" ? (
              <LoadFailed
                what={LOAD.yourAccounts}
                compact
                onRetry={loadSocial}
                testId="social-failed"
              />
            ) : (
              <SocialConnections
                platforms={social.platforms}
                accounts={social.accounts}
                onChanged={loadSocial}
              />
            )}
          </CardContent>
        </Card>

        {/* ── What is going out ──────────────────────────────────────────── */}
        <Card className="glass-panel border-hairline">
          <CardHeader>
            <CardTitle>{t(ACCOUNT.scheduledTitle)}</CardTitle>
            <CardDescription>{t(ACCOUNT.scheduledLead)}</CardDescription>
          </CardHeader>
          <CardContent>
            <ScheduledPosts />
          </CardContent>
        </Card>

        {/* ── How you sign in ────────────────────────────────────────────── */}
        <Card className="glass-panel border-hairline">
          <CardHeader>
            <CardTitle>{t(ACCOUNT.signinTitle)}</CardTitle>
            <CardDescription>{t(ACCOUNT.signinLead)}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <Label htmlFor="account-email" className="flex items-center gap-2 text-sm">
                <Mail className="w-3.5 h-3.5" /> {t(ACCOUNT.newEmail)}
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
                  {busy === "email" ? <Loader2 className="w-4 h-4 animate-spin" /> : t(ACCOUNT.sendConfirmation)}
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="account-password" className="flex items-center gap-2 text-sm">
                <KeyRound className="w-3.5 h-3.5" /> {t(ACCOUNT.newPassword)}
              </Label>
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  id="account-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={t(ACCOUNT.passwordHint)}
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
                  {busy === "password" ? <Loader2 className="w-4 h-4 animate-spin" /> : t(ACCOUNT.changePassword)}
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
                <LogOut className="w-4 h-4 me-2" />
                {t(COMMON.signOut)}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── Taking it with you ─────────────────────────────────────────── */}
        <Card className="glass-panel border-hairline">
          <CardHeader>
            <CardTitle>{t(ACCOUNT.dataTitle)}</CardTitle>
            <CardDescription>{t(ACCOUNT.dataLead)}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">{t(ACCOUNT.dataTokens)}</p>
            <Button
              variant="outline"
              className="self-start"
              disabled={busy === "export"}
              onClick={downloadData}
              data-testid="button-export-data"
            >
              {busy === "export" ? (
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
              ) : (
                <Download className="w-4 h-4 me-2" />
              )}
              {busy === "export" ? t(ACCOUNT.puttingTogether) : t(ACCOUNT.downloadData)}
            </Button>
          </CardContent>
        </Card>

        {/* ── Leaving ────────────────────────────────────────────────────── */}
        <Card className="glass-panel border-destructive/30">
          <CardHeader>
            <CardTitle className="text-destructive">{t(ACCOUNT.deleteTitle)}</CardTitle>
            <CardDescription>{t(ACCOUNT.deleteLead)}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {t(ACCOUNT.deleteBillingLead)}
              <button
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => window.open("https://users.freemius.com/", "_blank", "noopener")}
              >
                {t(ACCOUNT.deleteBillingLink)}
              </button>
              {t(ACCOUNT.deleteBillingTail)}
            </p>

            <div className="flex flex-col gap-2">
              <Label htmlFor="confirm-delete" className="text-sm">
                {t(ACCOUNT.deleteConfirmLead)}
                <span className="font-mono text-foreground">{t(ACCOUNT.deleteConfirmPhrase)}</span>
                {t(ACCOUNT.deleteConfirmTail)}
              </Label>
              <Input
                id="confirm-delete"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={t(ACCOUNT.deleteConfirmPhrase)}
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
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                    {t(ACCOUNT.deleting)}
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4 me-2" />
                    {t(ACCOUNT.deleteButton)}
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
