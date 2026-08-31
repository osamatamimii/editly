/**
 * The places a finished edit can go, and which of them this person has
 * connected.
 *
 * Five platforms, several accounts each, because people run more than one — an
 * agency posts to a client's Instagram and their own, and a product that
 * assumes one account per platform is a product they cannot use.
 *
 * The honest part is the state a platform is in before it works. Connecting
 * requires an app reviewed by the platform and credentials on this deployment,
 * and neither of those is something a person can do from this screen. So a
 * platform that is not switched on says so rather than offering a button that
 * fails — the same rule the login page follows for Google, and for the same
 * reason: a button that does nothing is indistinguishable from a product that
 * is broken.
 *
 * Said *once*, at the top, naming which platforms it applies to. It used to be
 * a paragraph inside every unavailable platform — the same sentence five times
 * with only the name changing, nine hundred pixels of it on a phone — which
 * does not make one fact into five, it buries the accounts somebody has really
 * connected underneath the explanation of the ones they have not.
 */
import { useState } from "react";
import { Loader2, Link2Off, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import { PlatformMark, BRAND } from "@/components/platform-mark";

export interface PlatformInfo {
  platform: string;
  label: string;
  connected: boolean;
  captionLimit: number;
  maxDurationSeconds: number;
  shape: "vertical" | "any";
  needsReview: boolean;
}

export interface ConnectedAccount {
  id: string;
  platform: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: string;
  statusDetail: string | null;
}

export function SocialConnections({
  platforms,
  accounts,
  onChanged,
}: {
  platforms: PlatformInfo[];
  accounts: ConnectedAccount[];
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  const disconnect = async (account: ConnectedAccount) => {
    setDisconnecting(account.id);
    try {
      const response = await apiFetch(`/api/social/accounts/${account.id}`, { method: "DELETE" });
      const body = (await response.json()) as { cancelledPosts?: number; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not disconnect that account.");
      toast({
        title: `${account.handle} disconnected`,
        // The number matters. Somebody who set up a week of posts and then
        // disconnected an account has lost that week, and finding out from a
        // post that never appeared is finding out too late.
        description:
          body.cancelledPosts && body.cancelledPosts > 0
            ? `${body.cancelledPosts} scheduled ${body.cancelledPosts === 1 ? "post was" : "posts were"} cancelled with it.`
            : "Nothing was scheduled to it.",
      });
      onChanged();
    } catch (error) {
      toast({
        title: "Could not disconnect",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setDisconnecting(null);
    }
  };

  const waiting = platforms.filter((p) => !p.connected && p.needsReview);
  const missing = platforms.filter((p) => !p.connected && !p.needsReview);

  return (
    <div className="space-y-3" data-testid="social-connections">
      {/*
        The reason, once.

        It was a paragraph inside every platform that is not switched on — the
        same sentence five times, with only the name changing, nine hundred
        pixels of it on a phone. Five copies of one fact do not make it five
        facts; they make the list unreadable and bury the accounts somebody has
        actually connected underneath them.

        So it is said here, naming which platforms it applies to, and each row
        below carries the two words that say where it stands.
      */}
      {waiting.length > 0 || missing.length > 0 ? (
        <p className="text-xs text-muted-foreground leading-relaxed" data-testid="social-why">
          {waiting.length > 0 ? (
            <>
              {waiting.map((p) => p.label).join(", ")}{" "}
              {waiting.length === 1 ? "reviews" : "review"} every app before letting one post on
              your behalf. The editing and the scheduling are built; that review is the part
              waiting on them.
            </>
          ) : null}
          {waiting.length > 0 && missing.length > 0 ? " " : null}
          {missing.length > 0 ? (
            <>This deployment does not have {missing.map((p) => p.label).join(" or ")} credentials yet.</>
          ) : null}
        </p>
      ) : null}

      {platforms.map((platform) => {
        const mine = accounts.filter((account) => account.platform === platform.platform);
        return (
          <div
            key={platform.platform}
            className="rounded-xl glass-panel border border-hairline p-4"
            data-testid={`social-platform-${platform.platform}`}
          >
            <div className="flex items-center gap-3">
              <PlatformMark
                platform={platform.platform}
                className={`w-5 h-5 flex-shrink-0 ${BRAND[platform.platform] ?? ""}`}
              />
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-sm">{platform.label}</div>
                <div className="text-xs text-muted-foreground">
                  {platform.captionLimit.toLocaleString()} characters
                  {platform.shape === "vertical" ? " · vertical only" : ""}
                </div>
              </div>
              {/*
                Two words, not a dead button.

                A `<Button disabled>Connect</Button>` sat here for any platform
                this deployment holds credentials for — which is exactly the
                thing the note at the top of this file says it will not do. A
                button that cannot be pressed is indistinguishable from a
                product that is broken, and it is worse than the sentence it
                replaced because it looks like the way in.
              */}
              <span
                className="text-xs text-muted-foreground flex-shrink-0"
                data-testid={`social-state-${platform.platform}`}
              >
                {mine.length > 0
                  ? `${mine.length} connected`
                  : platform.needsReview
                    ? "Waiting on review"
                    : "Not set up yet"}
              </span>
            </div>

            {mine.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {mine.map((account) => (
                  <li
                    key={account.id}
                    className="flex items-center gap-3 rounded-lg bg-surface-1 border border-hairline-faint px-3 py-2"
                  >
                    {account.avatarUrl ? (
                      <img
                        src={account.avatarUrl}
                        alt=""
                        className="w-7 h-7 rounded-full object-cover flex-shrink-0"
                      />
                    ) : (
                      <div className="w-7 h-7 rounded-full bg-surface-2 flex-shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{account.handle}</div>
                      {account.status !== "ok" ? (
                        <div className="text-xs text-warning flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                          {account.statusDetail ?? "Needs reconnecting."}
                        </div>
                      ) : account.displayName ? (
                        <div className="text-xs text-muted-foreground truncate">
                          {account.displayName}
                        </div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => disconnect(account)}
                      disabled={disconnecting === account.id}
                      className="flex-shrink-0 h-11 w-11 md:h-8 md:w-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors"
                      aria-label={`Disconnect ${account.handle}`}
                      data-testid={`button-disconnect-${account.id}`}
                    >
                      {disconnecting === account.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Link2Off className="w-4 h-4" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
