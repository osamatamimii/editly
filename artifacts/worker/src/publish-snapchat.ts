/**
 * Snapchat, and why there is no upload in this file.
 *
 * This file was opened to write the sixth publisher. What it contains instead
 * is the answer to the question that had to be asked first — *can what we want
 * be done at all for the people who use this product* — and the honest answer
 * is no, today, for a reason that is nothing to do with us.
 *
 * ## What was checked
 *
 * Snapchat has no public content API in the shape the other five have. The
 * nearest thing is the **Public Profile API**, under the Marketing API, and it
 * carries three separate blocks at once:
 *
 *   - it is **allowlist only**, so an app cannot simply be registered and used;
 *   - it requires a **Snap Business Account (Organization)**, which an ordinary
 *     creator connecting a personal Snapchat does not have;
 *   - and it is a **read** API. It reports metadata and statistics about a
 *     Public Profile. It does not create Stories or Spotlight posts.
 *
 * Any one of those would stop a publisher being written. Together they say that
 * the thing to build is not a client but a sentence.
 *
 * ## Why this is a file and not a deletion
 *
 * Snapchat is on the connect screen, in the scheduling composer, in the token
 * refresh table, and in the platform spec with its own caption and duration
 * limits. Removing it would be this product forgetting something it has already
 * shown somebody — and the rule in this repository is that what is on the
 * screen and not yet built stays, and gets built towards.
 *
 * So the connection keeps working, the composer keeps checking Snapchat's
 * limits, a post can still be scheduled, and the only thing that changes at
 * send time is *which sentence* comes back.
 *
 * ## And why a refusal here rather than the one that was already there
 *
 * `publisher.ts` has a fallback for a platform with no uploader: "Editly cannot
 * send to Snapchat yet. Nothing was posted." That is true, and it is the same
 * sentence a platform nobody has looked at would produce. It cannot tell
 * somebody whether to wait a week or never schedule this again, and the
 * difference matters more here than anywhere else in this file — because for
 * Snapchat the honest answer is "not until Snap opens an API that does this",
 * and that is worth knowing before somebody builds a posting schedule on it.
 *
 * A named refusal is also the thing that shows up in a test. A missing entry is
 * an absence, and an absence is what nobody notices for six months.
 *
 * ## What would replace this
 *
 * If Snap ships a content API, or grants this app the allowlist and a way to
 * post: everything else is already here. The account connects, the token
 * refreshes (`social-token.ts` has Snapchat's exchange), the limits are in
 * `SOCIAL_SPEC`, and `publisher.ts` already routes to this file. What is
 * missing is exactly one function, and it goes where the refusal is.
 */
import { PublishError, type Published } from "./publish-youtube";

/**
 * Why Snapchat cannot be posted to, in the words a person can act on.
 *
 * Exported so the suite reads the same sentence the customer does. A refusal
 * that a test rewrites in its own words is a refusal nobody has checked.
 */
export const SNAPCHAT_REFUSAL =
  "Snapchat has no API that lets an app post to a personal account: the nearest one is " +
  "allowlist-only, needs a Snap business organisation, and only reads profile statistics. " +
  "Nothing was posted, and nothing you can change will make this one go out. " +
  "Your connection and your schedule are kept, and this will start working the day Snap opens it up.";

export interface SnapchatUpload {
  /** A link Snapchat could fetch, if there were anywhere to hand it to. */
  videoUrl: string;
  caption: string;
  hashtags: string[];
  accessToken: string;
}

/**
 * Refuses, always, and says why.
 *
 * Shaped like the other publishers — same arguments, same `Published` return
 * type, same `PublishError` — so that the day it becomes an upload, nothing
 * around it changes. And it is reached through `UPLOADERS`, so the refusal is
 * on the ordinary path with the ordinary logging rather than in a special case
 * that a later edit could route around.
 */
export async function publishToSnapchat(_upload: SnapchatUpload): Promise<Published> {
  throw new PublishError(SNAPCHAT_REFUSAL);
}
