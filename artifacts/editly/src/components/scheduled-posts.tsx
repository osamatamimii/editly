/**
 * What is going out, and the way to stop it.
 *
 * A scheduler with no list is a promise with no receipt. Somebody sets up a
 * week of posts on a Sunday and then has no way to answer the only two
 * questions they will actually have on Wednesday — *is that still going out*,
 * and *can I stop it* — except by waiting to find out.
 *
 * The endpoints existed before this screen did, which is its own small lesson:
 * `GET /social/posts` and `DELETE /social/posts/:id` were written, tested and
 * reachable, and nothing in the product called either. A feature that only
 * exists in an API is a feature nobody has.
 *
 * ## The endings are not all failures
 *
 * A post can end five ways and they mean different things to the person
 * reading. `published` went out. `cancelled` was called back on purpose.
 * `failed` needs something fixed — a token, a caption. `missed` was not sent
 * because the publisher was down when it came due, and the honest thing to say
 * is that nothing went out and it can be scheduled again; filing it under
 * "failed" would put it beside problems to solve when it is a decision to
 * retake.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, X, ExternalLink, Clock, CircleCheck, CircleAlert, CircleSlash } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiFetch, apiJson } from "@/lib/api-fetch";
import { LoadFailed } from "@/components/load-failed";
import { PlatformMark, BRAND } from "@/components/platform-mark";

interface ScheduledPost {
  id: string;
  projectId: string;
  platform: string;
  caption: string;
  hashtags: string[];
  scheduledFor: string;
  status: string;
  externalUrl: string | null;
  error: string | null;
  publishedAt: string | null;
}

/** Each ending, said in the words that fit it. */
const ENDING: Record<
  string,
  { label: string; tone: string; Icon: typeof Clock }
> = {
  scheduled: { label: "Going out", tone: "text-muted-foreground", Icon: Clock },
  publishing: { label: "Sending", tone: "text-primary", Icon: Loader2 },
  published: { label: "Posted", tone: "text-success", Icon: CircleCheck },
  failed: { label: "Did not go", tone: "text-destructive", Icon: CircleAlert },
  // Not a failure. Nothing went wrong; it was simply too late to be worth
  // sending, and what it needs is a new time rather than a fix.
  missed: { label: "Not sent, too late", tone: "text-warning", Icon: CircleAlert },
  cancelled: { label: "Called back", tone: "text-muted-foreground", Icon: CircleSlash },
};

function when(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? `today, ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : date.toLocaleString([], {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      });
}

export function ScheduledPosts({ projectId }: { projectId?: string }) {
  const { toast } = useToast();
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    const { ok, body } = await apiJson<{ posts?: ScheduledPost[] }>(
      projectId ? `/api/social/posts?projectId=${encodeURIComponent(projectId)}` : "/api/social/posts",
    );
    // A read that failed must not render as "nothing is scheduled". That
    // sentence is a claim about somebody's week, and making it from a network
    // error is the failure this codebase keeps finding.
    if (!ok) {
      setState("failed");
      return;
    }
    setPosts(body.posts ?? []);
    setState("ready");
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const callBack = async (post: ScheduledPost) => {
    setCancelling(post.id);
    try {
      const response = await apiFetch(`/api/social/posts/${post.id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "That could not be called back.");
      }
      toast({ title: "Called back", description: "It will not go out." });
      await load();
    } catch (error) {
      toast({
        title: "Still scheduled",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setCancelling(null);
    }
  };

  if (state === "loading") {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Reading what is scheduled…
      </div>
    );
  }
  if (state === "failed") {
    return <LoadFailed what="your scheduled posts" compact onRetry={load} testId="posts-failed" />;
  }
  if (posts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="no-scheduled-posts">
        Nothing scheduled. From a finished export you can send an edit to several accounts at a time
        you choose.
      </p>
    );
  }

  return (
    <ul className="space-y-2" data-testid="scheduled-posts">
      {posts.map((post) => {
        const ending = ENDING[post.status] ?? ENDING.scheduled;
        const { Icon } = ending;
        return (
          <li
            key={post.id}
            className="flex items-start gap-3 rounded-lg bg-surface-1 border border-hairline-faint px-3 py-2.5"
            data-testid={`scheduled-post-${post.id}`}
          >
            <PlatformMark
              platform={post.platform}
              className={`w-4 h-4 flex-shrink-0 mt-0.5 ${BRAND[post.platform] ?? ""}`}
            />
            <div className="min-w-0 flex-1">
              <div dir="auto" className="text-sm truncate">
                {post.caption || "No caption"}
              </div>
              <div className={`text-xs flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 ${ending.tone}`}>
                <span className="inline-flex items-center gap-1.5">
                  <Icon
                    className={`w-3 h-3 flex-shrink-0 ${post.status === "publishing" ? "animate-spin" : ""}`}
                  />
                  {ending.label} {when(post.scheduledFor)}
                </span>
                {post.externalUrl ? (
                  <a
                    href={post.externalUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 hover:underline whitespace-nowrap"
                  >
                    See it <ExternalLink className="w-3 h-3" />
                  </a>
                ) : null}
              </div>
              {/* The reason, in full. A post that did not go out with a truncated
                  explanation is a support ticket rather than an answer. */}
              {post.error ? (
                <p className="text-xs text-muted-foreground mt-1 leading-snug">{post.error}</p>
              ) : null}
            </div>

            {/* Only what has not left. "Sending" is a row the worker is holding
                right now, and cancelling it here would leave the two of us
                disagreeing about whether it went out. */}
            {post.status === "scheduled" ? (
              <button
                type="button"
                onClick={() => callBack(post)}
                disabled={cancelling === post.id}
                className="flex-shrink-0 h-11 w-11 md:h-8 md:w-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors"
                aria-label="Call this post back"
                data-testid={`button-cancel-${post.id}`}
              >
                {cancelling === post.id ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <X className="w-4 h-4" />
                )}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
