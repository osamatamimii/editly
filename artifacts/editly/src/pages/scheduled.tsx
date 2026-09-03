/**
 * What is going out, in a place somebody can find.
 *
 * The scheduling was built, tested and reachable, and the first person to look
 * for it in the product could not find it. He was right not to: it lived in
 * two places, and neither of them is where you would look. The composer is at
 * the bottom of the export screen, visible only after a render finishes; the
 * list of what is queued is three cards down the *account* page, under the
 * plan and the connected addresses.
 *
 * That is the same failure this codebase has already written down once —
 * a feature that only exists in an API is a feature nobody has — one level up.
 * The endpoints exist, the screens exist, and there was no door.
 *
 * So this is the door: connections and the queue on one page, off the
 * dashboard's own header beside Clips. It shares its two components with the
 * account page rather than reimplementing either, because two lists of
 * scheduled posts that could disagree is worse than one that is hard to find.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, CalendarClock } from "lucide-react";
import { BackButton } from "@/components/back-button";
import { LoadFailed } from "@/components/load-failed";
import { SocialConnections, type PlatformInfo, type ConnectedAccount } from "@/components/social-connections";
import { ScheduledPosts } from "@/components/scheduled-posts";
import { apiJson } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/language";
import { ACCOUNT } from "@/lib/copy/account";
import { LOAD } from "@/lib/copy/common";
import { SCHEDULED } from "@/lib/copy/scheduled";

export default function Scheduled() {
  const { toast } = useToast();
  const { t, fmt } = useLanguage();
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([]);
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);

  const load = useCallback(async () => {
    setState("loading");
    const [offered, connected] = await Promise.all([
      apiJson<{ platforms?: PlatformInfo[] }>("/api/social/platforms"),
      apiJson<{ accounts?: ConnectedAccount[] }>("/api/social/accounts"),
    ]);
    // Both, or neither. A page that lists connected accounts against an empty
    // set of platforms says "nothing is supported" about a deployment that
    // supports five, which is a claim rather than a loading state.
    if (!offered.ok || !connected.ok) {
      setState("failed");
      return;
    }
    setPlatforms(offered.body.platforms ?? []);
    setAccounts(connected.body.accounts ?? []);
    setState("ready");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /*
    What the platform said, on the way back in.

    A connection ends as a browser navigation from Instagram or Google to this
    page, carrying its verdict on the query string. Without this the page looks
    exactly the same whether the connection worked or was refused — and the one
    thing a person needs after signing in somewhere else is to be told whether
    it took.

    The parameters are removed once read, with `replaceState` rather than a
    navigation, so a refresh does not repeat a toast about something that
    happened five minutes ago and the back button still goes where it went.
  */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    if (!connected) return;
    const platform = params.get("platform") ?? t(SCHEDULED.thatAccount);
    if (connected === "yes") {
      toast({
        title: fmt(SCHEDULED.connected, params.get("handle") ?? platform),
        description: t(SCHEDULED.connectedDetail),
      });
      void load();
    } else {
      toast({
        title: fmt(SCHEDULED.notConnected, platform),
        // The platform's own words. "redirect_uri mismatch" is something
        // somebody can act on; "could not connect" is not.
        description: params.get("why") ?? t(SCHEDULED.refusedByPlatform),
        variant: "destructive",
      });
    }
    window.history.replaceState({}, "", window.location.pathname);
  }, [toast, load, t, fmt]);

  return (
    <div className="min-h-screen px-4 sm:px-6 py-6 sm:py-10 max-w-4xl mx-auto flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <BackButton fallback="/dashboard" />
        <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-3">
          <CalendarClock className="w-6 h-6 text-secondary flex-shrink-0" />
          {t(SCHEDULED.title)}
        </h1>
        <p className="text-sm text-muted-foreground max-w-prose">{t(SCHEDULED.lead)}</p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-muted-foreground">{t(SCHEDULED.yourAccounts)}</h2>
        {state === "loading" ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> {t(ACCOUNT.socialReading)}
          </div>
        ) : state === "failed" ? (
          <LoadFailed what={LOAD.yourAccounts} compact onRetry={load} testId="social-failed" />
        ) : (
          <SocialConnections platforms={platforms} accounts={accounts} onChanged={load} />
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-muted-foreground">{t(SCHEDULED.whatIsGoingOut)}</h2>
        <ScheduledPosts />
      </section>
    </div>
  );
}
