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
 * platform that is not switched on says so, in a sentence that names what is
 * missing, rather than offering a button that fails. That is the same rule the
 * login page follows for Google, and it exists because a button that does
 * nothing is indistinguishable from a product that is broken.
 */
import { useState } from "react";
import { Loader2, Link2Off, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
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

  return (
    <div className="space-y-3" data-testid="social-connections">
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
              {platform.connected ? (
                <Button size="sm" variant="outline" className="rounded-full flex-shrink-0" disabled>
                  Connect
                </Button>
              ) : null}
            </div>

            {/*
              Why a platform is not available, said once and plainly.

              "Coming soon" is what a product says when it does not want to
              explain. The real reason is that posting on somebody's behalf
              needs an app the platform has reviewed, and that is a fact worth
              telling the person who is wondering where the button is.
            */}
            {!platform.connected ? (
              <p className="text-xs text-muted-foreground mt-3 leading-snug">
                Not switched on yet.{" "}
                {platform.needsReview
                  ? `${platform.label} reviews every app before it will let one post on your behalf. The editing and the scheduling are built; this is the part that is waiting on them.`
                  : `This deployment does not have ${platform.label} credentials yet.`}
              </p>
            ) : null}

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
