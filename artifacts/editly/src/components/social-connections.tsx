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

/** The mark, drawn rather than fetched — five logos are five network requests. */
function PlatformMark({ platform, className = "" }: { platform: string; className?: string }) {
  const common = { className, viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": true } as const;
  switch (platform) {
    case "instagram":
      return (
        <svg {...common}>
          <path d="M12 2.16c3.2 0 3.58.01 4.85.07 1.17.05 1.8.25 2.23.41.56.22.96.48 1.38.9.42.42.68.82.9 1.38.16.42.36 1.06.41 2.23.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.05 1.17-.25 1.8-.41 2.23-.22.56-.48.96-.9 1.38-.42.42-.82.68-1.38.9-.42.16-1.06.36-2.23.41-1.27.06-1.65.07-4.85.07s-3.58-.01-4.85-.07c-1.17-.05-1.8-.25-2.23-.41-.56-.22-.96-.48-1.38-.9-.42-.42-.68-.82-.9-1.38-.16-.42-.36-1.06-.41-2.23C2.17 15.58 2.16 15.2 2.16 12s.01-3.58.07-4.85c.05-1.17.25-1.8.41-2.23.22-.56.48-.96.9-1.38.42-.42.82-.68 1.38-.9.42-.16 1.06-.36 2.23-.41C8.42 2.17 8.8 2.16 12 2.16Zm0 5.18a4.66 4.66 0 1 0 0 9.32 4.66 4.66 0 0 0 0-9.32Zm0 7.69a3.03 3.03 0 1 1 0-6.06 3.03 3.03 0 0 1 0 6.06Zm5.93-7.87a1.09 1.09 0 1 1-2.18 0 1.09 1.09 0 0 1 2.18 0Z" />
        </svg>
      );
    case "facebook":
      return (
        <svg {...common}>
          <path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5.02 3.66 9.18 8.44 9.94v-7.03H7.9v-2.91h2.54V9.85c0-2.52 1.49-3.91 3.77-3.91 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.78-1.63 1.57v1.89h2.78l-.45 2.91h-2.33V22c4.78-.76 8.44-4.92 8.44-9.94Z" />
        </svg>
      );
    case "tiktok":
      return (
        <svg {...common}>
          <path d="M16.6 5.82A4.28 4.28 0 0 1 15.54 3h-3.09v12.4a2.59 2.59 0 0 1-2.59 2.5 2.59 2.59 0 1 1 .77-5.06V9.7a5.68 5.68 0 0 0-.77-.05A5.66 5.66 0 1 0 15.54 15.3V9.01a7.35 7.35 0 0 0 4.3 1.38V7.3a4.29 4.29 0 0 1-3.24-1.48Z" />
        </svg>
      );
    case "x":
      return (
        <svg {...common}>
          <path d="M17.53 3h3.14l-6.86 7.84L21.88 21h-6.3l-4.94-6.45L4.98 21H1.84l7.34-8.39L1.7 3h6.46l4.46 5.9L17.53 3Zm-1.1 16.13h1.74L7.65 4.78H5.79l10.64 14.35Z" />
        </svg>
      );
    case "snapchat":
      return (
        <svg {...common}>
          <path d="M12 2c2.7 0 4.6 1.9 4.7 4.6l.05 1.65c.36.14.72.13 1.1-.02.5-.2 1.06.06 1.2.55.13.47-.15.9-.63 1.12l-1.2.54c-.2.09-.3.31-.24.52.36 1.24 1.4 2.6 2.9 3.06.44.13.66.6.5 1.02-.2.55-1.02.83-1.9.98-.15.03-.26.15-.3.3l-.13.6c-.08.36-.42.6-.79.55-.5-.06-1.1-.1-1.66.02-.6.13-1.03.5-1.5.9-.63.53-1.3 1.06-2.6 1.06s-1.97-.53-2.6-1.06c-.47-.4-.9-.77-1.5-.9-.56-.12-1.16-.08-1.66-.02a.72.72 0 0 1-.79-.55l-.13-.6a.38.38 0 0 0-.3-.3c-.88-.15-1.7-.43-1.9-.98a.78.78 0 0 1 .5-1.02c1.5-.46 2.54-1.82 2.9-3.06a.4.4 0 0 0-.24-.52l-1.2-.54c-.48-.22-.76-.65-.63-1.12.14-.49.7-.75 1.2-.55.38.15.74.16 1.1.02l.05-1.65C7.4 3.9 9.3 2 12 2Z" />
        </svg>
      );
    default:
      return null;
  }
}

const BRAND: Record<string, string> = {
  instagram: "text-[#E1306C]",
  facebook: "text-[#1877F2]",
  tiktok: "text-foreground",
  x: "text-foreground",
  snapchat: "text-[#FFFC00]",
};

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
