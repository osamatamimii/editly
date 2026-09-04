/**
 * Putting a finished edit on an Instagram Reel or a Facebook Page.
 *
 * Both go through the Graph API and both work the same way at the level that
 * matters here: **Meta fetches the video from us**, rather than taking it in a
 * body. So the worker never downloads the file for these two — it hands over a
 * signed link and Meta pulls it. That is cheaper than every other platform and
 * it is also the constraint that shapes this file: the link must outlive Meta's
 * own fetch, which can take minutes on a large Reel.
 *
 * ## The connected account cannot be posted to
 *
 * This is the finding that made this file longer than it looks.
 *
 * `identityFor` stores what `/me` returns when somebody connects: a **Facebook
 * user**. Neither Instagram nor Facebook will accept a post to that. A Reel
 * goes to an *Instagram Business account*, which is reached through a *Page*;
 * a Facebook video goes to a *Page*, with the **Page's own token** and not the
 * user's. So both are resolved here, at send time, from the token in the row.
 *
 * It could have been stored at connection instead, and one day it should be —
 * it is one request per post that never changes. That day came: the columns
 * exist, the connection fills them, and the resolution below runs only when
 * they are empty. Which is not the same as deleting it — a row connected
 * before those columns existed still has to be able to post, so this stays as
 * the fallback and the stored answer is preferred over it.
 *
 * ## And it used to pick the Page for you
 *
 * `pageFor` took the first entry Meta returned. Somebody managing two Pages got
 * their video on whichever one Meta ordered first, and that ordering is not a
 * promise Meta makes. Nothing failed: a post went out, to a real Page, and only
 * its owner could tell it was the wrong one. Choosing is now the connect
 * screen's job, and this file only takes the answer.
 *
 * ## And a token that could not be refreshed
 *
 * `social-token.ts` used to refresh four of the six platforms and deliberately
 * not these two, on the grounds that Meta's extension is a different exchange
 * entirely. True, and the consequence was a sixty-day cliff: every Meta
 * connection stopped working two months after it was made, with no event, no
 * log line, and nothing to look at until a post failed. It now takes Meta's own
 * exchange, before the send, like the rest.
 */
import { PublishError, type Published } from "./publish-youtube";
import { withDeadline, PUBLISH_TIMEOUT_MS } from "./providers/deadline";
import { captionWith, truncateToGraphemes } from "@workspace/api-zod";

const GRAPH = "https://graph.facebook.com/v21.0";

/** Instagram's caption ceiling. Facebook's is far larger and not worth a second path. */
const INSTAGRAM_CAPTION_LIMIT = 2200;

/**
 * How long to wait for Meta to fetch and encode the video.
 *
 * A Reel container is not ready the moment it is created: Meta downloads the
 * file from the link, transcodes it, and only then will it publish. Publishing
 * early answers with an error that reads like a permissions problem, which is
 * the wrong thing to put in front of somebody.
 */
const READY_DEADLINE_MS = 8 * 60 * 1000;
const READY_INTERVAL_MS = 5_000;

export interface MetaUpload {
  /** A link Meta can fetch without a credential of ours, for long enough. */
  videoUrl: string;
  caption: string;
  hashtags: string[];
  /** The connected user's token. The Page token is resolved from it if needed. */
  accessToken: string;
  /**
   * The Page this connection posts to, decided when it was made.
   *
   * When it is here, nothing is asked of Meta before the post: this is two
   * Graph calls per post that this replaces. When it is absent — a row from
   * before the column, or an owner who has not chosen between several Pages —
   * `pageFor` resolves it exactly as it always did.
   */
  page?: { id: string; token: string; name: string } | null;
  /** The Instagram business account attached to that Page, when it is known. */
  instagramUserId?: string | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The caption with its hashtags, inside the platform's ceiling. */
export function captionFor(caption: string, hashtags: string[], limit = INSTAGRAM_CAPTION_LIMIT): string {
  /*
    Assembled and cut by the contract package, not here.

    Two things were wrong with the copy that was here, and both are invisible
    until the boundary. It joined with a blank line while `captionLength` — the
    check the composer shows the person — counted a single space, so a caption
    measured at exactly the limit arrived one over and lost its last hashtag on
    the way out. And it cut with `slice`, which counts UTF-16 code units, so a
    cut landing mid-emoji left a lone surrogate: the post ended in a
    replacement glyph where somebody's last word should have been.
  */
  return truncateToGraphemes(captionWith(caption, hashtags), limit);
}

async function graph(
  doFetch: typeof fetch,
  method: "GET" | "POST",
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = new URL(`${GRAPH}${path}`);
  /*
    Parameters in the query string for a GET and in the body for a POST.

    Not a style choice: a caption goes in a POST, and a caption in a URL is a
    caption in every proxy log between here and Meta — somebody's words, and
    sometimes their name, written down in places nobody chose.
  */
  const init: RequestInit = { method };
  if (method === "GET") {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  } else {
    init.body = new URLSearchParams(params);
  }

  const response = await doFetch(url.toString(), init);
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: { message?: string; type?: string; code?: number; error_user_msg?: string };
  };
  if (payload.error) {
    /*
      `error_user_msg` is Meta's own sentence written for the person rather than
      for the developer, and where it exists it is better than anything we would
      write. `message` is the fallback and it is still theirs.
    */
    const said = payload.error.error_user_msg ?? payload.error.message ?? "no reason given";
    throw new PublishError(String(said).slice(0, 200));
  }
  if (!response.ok) throw new PublishError(`Meta answered ${response.status} with no reason attached`);
  return payload;
}

export interface Page {
  id: string;
  /** The Page's own token. A user token cannot post to a Page. */
  token: string;
  name: string;
}

/**
 * The Page behind the connected account.
 *
 * The first one, when there are several. Choosing is a thing the connection
 * screen should ask and does not yet — and picking the first is at least
 * deterministic and inspectable, where picking by some heuristic would put
 * somebody's video on a Page they did not expect for a reason nobody could
 * reconstruct.
 */
export async function pageFor(accessToken: string, doFetch: typeof fetch = fetch): Promise<Page> {
  const payload = await graph(doFetch, "GET", "/me/accounts", {
    fields: "id,name,access_token",
    access_token: accessToken,
  });
  const pages = (payload["data"] as Array<Record<string, unknown>> | undefined) ?? [];
  const first = pages[0];
  if (!first?.["access_token"]) {
    throw new PublishError(
      "That Facebook account manages no Page, and both Instagram and Facebook posts go to a Page. Nothing was posted.",
    );
  }
  return {
    id: String(first["id"]),
    token: String(first["access_token"]),
    name: String(first["name"] ?? "your Page"),
  };
}

/** The Instagram Business account attached to that Page, if there is one. */
export async function instagramAccountFor(page: Page, doFetch: typeof fetch = fetch): Promise<string> {
  const payload = await graph(doFetch, "GET", `/${page.id}`, {
    fields: "instagram_business_account",
    access_token: page.token,
  });
  const linked = payload["instagram_business_account"] as { id?: string } | undefined;
  if (!linked?.id) {
    throw new PublishError(
      `No Instagram account is linked to ${page.name}. Link one in Meta's settings, then try again. Nothing was posted.`,
    );
  }
  return String(linked.id);
}

/**
 * Wait for Meta to finish fetching and encoding the video.
 *
 * `FINISHED` is the only state that can be published. `ERROR` and `EXPIRED` are
 * ends, and publishing an `IN_PROGRESS` container answers with something that
 * reads like a permissions problem — which would send somebody to check their
 * permissions over a video that was merely still uploading.
 */
async function waitForContainer(
  containerId: string,
  token: string,
  doFetch: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<void> {
  const startedAt = now();
  for (;;) {
    const payload = await graph(doFetch, "GET", `/${containerId}`, {
      fields: "status_code,status",
      access_token: token,
    });
    const code = String(payload["status_code"] ?? "");
    if (code === "FINISHED") return;
    if (code === "ERROR" || code === "EXPIRED") {
      const detail = payload["status"] ? String(payload["status"]) : code;
      throw new PublishError(`Instagram could not process the video: ${detail}`.slice(0, 200));
    }
    if (now() - startedAt > READY_DEADLINE_MS) {
      throw new PublishError(
        "Instagram is still fetching the video and has not finished. Nothing was posted, and nothing was sent twice.",
      );
    }
    await sleep(READY_INTERVAL_MS);
  }
}

export async function publishToInstagram(upload: MetaUpload): Promise<Published> {
  // Deadlined, because Node's `fetch` has no timeout and a publisher that
  // never returns stops this worker claiming renders. The publish budget
  // rather than the provider one — this streams a master. See PUBLISH_TIMEOUT_MS.
  const doFetch = upload.fetchImpl ?? withDeadline(fetch, PUBLISH_TIMEOUT_MS);
  const sleep = upload.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = upload.now ?? (() => Date.now());

  const page = upload.page ?? (await pageFor(upload.accessToken, doFetch));
  const igUser = upload.instagramUserId ?? (await instagramAccountFor(page, doFetch));

  const container = await graph(doFetch, "POST", `/${igUser}/media`, {
    media_type: "REELS",
    video_url: upload.videoUrl,
    caption: captionFor(upload.caption, upload.hashtags),
    /*
      Shared to the main feed as well as to Reels, which is what somebody
      scheduling a post means — a Reel that appears only in the Reels tab is
      invisible to the followers who look at a profile.
    */
    share_to_feed: "true",
    access_token: page.token,
  });
  const containerId = container["id"] ? String(container["id"]) : null;
  if (!containerId) throw new PublishError("Instagram accepted the details and returned no container");

  await waitForContainer(containerId, page.token, doFetch, sleep, now);

  const published = await graph(doFetch, "POST", `/${igUser}/media_publish`, {
    creation_id: containerId,
    access_token: page.token,
  });
  const id = published["id"] ? String(published["id"]) : null;
  if (!id) throw new PublishError("Instagram took the video and did not say what it became");

  /*
    The real permalink, asked for, because the one we were building did not work.

    `externalUrl` was `https://www.instagram.com/reel/${id}/`, and `id` is the
    numeric media id `media_publish` returns. Instagram's `/reel/` path takes a
    shortcode, not a media id, so every "View post" link this product has ever
    written for a Reel lands on "this page isn't available". Nothing failed: the
    post genuinely went out, the row says `published`, and the URL is only ever
    rendered as a link — so the only person who finds out is the customer, on
    their own post, a day later.

    The comment that was here said "a link we could not build is a field left
    null", which was the right rule and was not what the code did. Now it is:
    one GET for the `permalink` field, best effort, and null when it does not
    come back. The post is already published by this point, so nothing about
    its reliability depends on this request.
  */
  let permalink: string | null = null;
  try {
    const read = await graph(doFetch, "GET", `/${id}`, { fields: "permalink", access_token: page.token });
    const value = read["permalink"];
    if (typeof value === "string" && value.startsWith("https://")) permalink = value;
  } catch {
    // A link we could not build is a field left null, and the row still carries
    // the id that finds it.
  }

  return {
    externalPostId: id,
    externalUrl: permalink,
  };
}

export async function publishToFacebook(upload: MetaUpload): Promise<Published> {
  // Deadlined, because Node's `fetch` has no timeout and a publisher that
  // never returns stops this worker claiming renders. The publish budget
  // rather than the provider one — this streams a master. See PUBLISH_TIMEOUT_MS.
  const doFetch = upload.fetchImpl ?? withDeadline(fetch, PUBLISH_TIMEOUT_MS);
  const page = upload.page ?? (await pageFor(upload.accessToken, doFetch));

  const posted = await graph(doFetch, "POST", `/${page.id}/videos`, {
    file_url: upload.videoUrl,
    description: captionFor(upload.caption, upload.hashtags, 63_206),
    access_token: page.token,
  });
  const id = posted["id"] ? String(posted["id"]) : null;
  if (!id) throw new PublishError("Facebook took the video and did not say what it became");

  return {
    externalPostId: id,
    externalUrl: `https://www.facebook.com/${id}`,
  };
}
