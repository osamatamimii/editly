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
import { useLanguage } from "@/lib/language";
import { CONNECTIONS } from "@/lib/copy/scheduled";

export interface PlatformInfo {
  platform: string;
  label: string;
  connected: boolean;
  captionLimit: number;
  maxDurationSeconds: number;
  shape: "vertical" | "any";
  needsReview: boolean;
}

export interface PageChoice {
  id: string;
  name: string;
}

export interface ConnectedAccount {
  id: string;
  platform: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: string;
  statusDetail: string | null;
  /**
   * Which Page a Meta connection posts to, and the Pages it could.
   *
   * Absent for every other platform. `pageChoices` carries names and ids only:
   * the Page's token is a credential and never leaves the server.
   */
  pageId?: string | null;
  pageName?: string | null;
  pageChoices?: PageChoice[] | null;
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
  const { t, fmt } = useLanguage();
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [choosingPage, setChoosingPage] = useState<string | null>(null);

  /*
    Which Page this connection posts to.

    Asked here because here is the only place it can honestly be asked. Both
    Meta destinations go through a Page, and the publisher used to take
    whichever one Meta listed first — so somebody managing two Pages found their
    video on the wrong one, with nothing failing anywhere. One Page is answered
    at connection and never reaches this screen; this is for the several.

    The id goes to the server and the *token* does not: the server asks Meta for
    the token belonging to the id it was given, with the connection's own
    credential. A page token arriving from a browser would be a credential the
    server took from outside.
  */
  const choosePage = async (account: ConnectedAccount, pageId: string, pageName: string) => {
    setChoosingPage(account.id);
    try {
      const response = await apiFetch(`/api/social/accounts/${account.id}/page`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageId }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? t(CONNECTIONS.couldNotSaveChoice));
      toast({
        title: fmt(CONNECTIONS.postingTo, pageName),
        description: t(CONNECTIONS.postingToDetail),
      });
      onChanged();
    } catch (error) {
      toast({
        title: t(CONNECTIONS.couldNotSetPage),
        description: error instanceof Error ? error.message : t(CONNECTIONS.tryAgain),
        variant: "destructive",
      });
    } finally {
      setChoosingPage(null);
    }
  };

  /**
   * Send them to the platform to sign in.
   *
   * The URL is asked for rather than navigated to, and that is not a
   * roundabout way of doing a redirect. Every route in this API is reached
   * with an `Authorization` header, and `fetch` follows a 302 with that header
   * still attached — so a redirecting endpoint would hand this person's Editly
   * bearer token to Facebook. The server returns a URL; the page opens it.
   *
   * Same tab, not a popup. A popup during an OAuth round trip is a blocked
   * window on half of mobile Safari, and coming back to a tab that closed
   * itself is a worse ending than coming back to the page you left.
   */
  const connect = async (platform: string, label: string) => {
    setConnecting(platform);
    try {
      const response = await apiFetch(`/api/social/connect/${platform}`, { method: "POST" });
      const body = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !body.url) {
        throw new Error(body.error ?? fmt(CONNECTIONS.couldNotStartConnect, label));
      }
      window.location.href = body.url;
    } catch (error) {
      setConnecting(null);
      toast({
        title: fmt(CONNECTIONS.couldNotConnect, label),
        description: error instanceof Error ? error.message : t(CONNECTIONS.tryAgain),
        variant: "destructive",
      });
    }
  };

  const disconnect = async (account: ConnectedAccount) => {
    setDisconnecting(account.id);
    try {
      const response = await apiFetch(`/api/social/accounts/${account.id}`, { method: "DELETE" });
      const body = (await response.json()) as { cancelledPosts?: number; error?: string };
      if (!response.ok) throw new Error(body.error ?? t(CONNECTIONS.couldNotDisconnectDetail));
      toast({
        title: fmt(CONNECTIONS.disconnected, account.handle),
        // The number matters. Somebody who set up a week of posts and then
        // disconnected an account has lost that week, and finding out from a
        // post that never appeared is finding out too late.
        description:
          body.cancelledPosts && body.cancelledPosts > 0
            ? fmt(CONNECTIONS.cancelledWithIt, body.cancelledPosts)
            : t(CONNECTIONS.nothingScheduledToIt),
      });
      onChanged();
    } catch (error) {
      toast({
        title: t(CONNECTIONS.couldNotDisconnect),
        description: error instanceof Error ? error.message : t(CONNECTIONS.tryAgain),
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
          {waiting.length > 0
            ? fmt(CONNECTIONS.reviews, waiting.map((p) => p.label).join(", "), waiting.length)
            : null}
          {waiting.length > 0 && missing.length > 0 ? " " : null}
          {missing.length > 0
            ? fmt(CONNECTIONS.noCredentials, missing.map((p) => p.label).join(t(CONNECTIONS.or)))
            : null}
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
                  {fmt(CONNECTIONS.characters, platform.captionLimit.toLocaleString("en-US"))}
                  {platform.shape === "vertical" ? t(CONNECTIONS.verticalOnly) : ""}
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
              {/*
                A button only where one can work.

                `connected` is this deployment holding credentials for the
                platform, and it is the whole condition: without them the
                button would open an authorize URL with an empty client id and
                come back with the platform's own error, which reads as our bug
                and is not one. Where there are none, the two words stay.
              */}
              {platform.connected ? (
                <button
                  type="button"
                  onClick={() => void connect(platform.platform, platform.label)}
                  disabled={connecting !== null}
                  className="flex-shrink-0 h-11 md:h-8 px-3 rounded-full text-xs font-medium border border-hairline bg-surface-1 hover:border-primary/40 hover:bg-white/[0.05] transition-colors disabled:opacity-40 flex items-center gap-1.5"
                  data-testid={`button-connect-${platform.platform}`}
                >
                  {connecting === platform.platform ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : null}
                  {mine.length > 0 ? t(CONNECTIONS.addAnother) : t(CONNECTIONS.connect)}
                </button>
              ) : (
                <span
                  className="text-xs text-muted-foreground flex-shrink-0"
                  data-testid={`social-state-${platform.platform}`}
                >
                  {mine.length > 0
                    ? fmt(CONNECTIONS.countConnected, mine.length)
                    : platform.needsReview
                      ? t(CONNECTIONS.waitingReview)
                      : t(CONNECTIONS.notSetUp)}
                </span>
              )}
            </div>

            {mine.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {mine.map((account) => (
                  <li
                    key={account.id}
                    className="rounded-lg bg-surface-1 border border-hairline-faint px-3 py-2"
                  >
                    <div className="flex items-center gap-3">
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
                      <div dir="auto" className="text-sm font-medium truncate">{account.handle}</div>
                      {account.status !== "ok" ? (
                        <div className="text-xs text-warning flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                          {account.statusDetail ?? t(CONNECTIONS.needsReconnecting)}
                        </div>
                      ) : account.pageName ? (
                        /*
                          Where this actually posts, said on the row.

                          A Facebook connection shows the *person* who signed in
                          and posts to a *Page*, and those are different names.
                          Somebody with two Pages had no way at all to tell
                          which one they were about to publish to.
                        */
                        <div dir="auto" className="text-xs text-muted-foreground truncate">
                          {fmt(CONNECTIONS.postsTo, account.pageName)}
                        </div>
                      ) : account.displayName ? (
                        <div dir="auto" className="text-xs text-muted-foreground truncate">
                          {account.displayName}
                        </div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => disconnect(account)}
                      disabled={disconnecting === account.id}
                      className="flex-shrink-0 h-11 w-11 md:h-8 md:w-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors"
                      aria-label={fmt(CONNECTIONS.disconnect, account.handle)}
                      data-testid={`button-disconnect-${account.id}`}
                    >
                      {disconnecting === account.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Link2Off className="w-4 h-4" />
                      )}
                    </button>
                    </div>

                    {/*
                      The one question this screen has to ask.

                      Only when there is something to ask: a connection managing
                      one Page has it stored already and never gets here. Shown
                      as the Pages themselves rather than a dropdown with a save
                      button, because there is one decision and pressing the
                      name of the Page is the whole of it.
                    */}
                    {!account.pageId && (account.pageChoices?.length ?? 0) > 1 ? (
                      <div className="mt-2 pt-2 border-t border-hairline-faint" data-testid={`page-choice-${account.id}`}>
                        <div className="text-xs text-muted-foreground mb-2">
                          {fmt(CONNECTIONS.whichPage, account.pageChoices!.length)}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {account.pageChoices!.map((page) => (
                            <button
                              key={page.id}
                              type="button"
                              onClick={() => void choosePage(account, page.id, page.name)}
                              disabled={choosingPage !== null}
                              className="h-11 md:h-8 px-3 rounded-full text-xs font-medium border border-hairline bg-surface-2 hover:border-primary/40 transition-colors disabled:opacity-40 flex items-center gap-1.5"
                              data-testid={`button-page-${page.id}`}
                            >
                              {choosingPage === account.id ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : null}
                              {page.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
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
