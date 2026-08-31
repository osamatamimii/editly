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

export default function Scheduled() {
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

  return (
    <div className="min-h-screen px-4 sm:px-6 py-6 sm:py-10 max-w-4xl mx-auto flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <BackButton fallback="/dashboard" />
        <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-3">
          <CalendarClock className="w-6 h-6 text-secondary flex-shrink-0" />
          Scheduled
        </h1>
        <p className="text-sm text-muted-foreground max-w-prose">
          Connect the accounts you post to, then send a finished edit to as many of them as you like
          at a time you choose. You can call a post back until it leaves.
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-muted-foreground">Your accounts</h2>
        {state === "loading" ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Reading your connections…
          </div>
        ) : state === "failed" ? (
          <LoadFailed what="your connected accounts" compact onRetry={load} testId="social-failed" />
        ) : (
          <SocialConnections platforms={platforms} accounts={accounts} onChanged={load} />
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-muted-foreground">What is going out</h2>
        <ScheduledPosts />
      </section>
    </div>
  );
}
