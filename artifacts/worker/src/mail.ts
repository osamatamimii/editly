import { addressFor, renderFailed, renderFinished, postFailed, send, logMailWith, type MailLog, type Letter } from "@workspace/mail";

/**
 * Telling somebody their render is done, from the only process that knows.
 *
 * A render takes minutes, so the person who asked for it is — by design, not by
 * accident — somewhere else by the time it lands. Until now the only way to
 * find out was to have left the tab open, which is the opposite of what a queue
 * is for.
 *
 * The sending itself is `@workspace/mail`: one deduplication table, one
 * provider, one language rule. It moved out of the API server the day this file
 * was written, because the worker must not import that deployment's modules and
 * a second sender here would mean two copies of "have we already told them" —
 * which is the one question `mail_sends` exists to answer.
 *
 * ## Everything here is best-effort, and that is the whole design
 *
 * The render is finished and paid for by the time any of this runs. A mail
 * provider having a bad minute must not turn a completed job into a retried
 * one — the rule the review pass, the preview encode and the summary message
 * are each written under, all three of them on this very path.
 */

let log: MailLog = { info: () => {}, warn: () => {} };

/** Called once at startup, with the worker's own logger. Silent until it is. */
export function mailLogsTo(logger: MailLog): void {
  log = logger;
  logMailWith(logger);
}

/** Told once per job, ever: the job id is the deduplication key. */
export async function tellThemTheEditIsReady(input: {
  userId: string;
  jobId: string;
  projectId: string;
  projectTitle: string | null;
  seconds: number | null;
}): Promise<void> {
  await tell(
    input.userId,
    "render.finished",
    input.jobId,
    renderFinished(input.projectTitle ?? "your project", input.projectId, input.seconds),
  );
}

/**
 * And once per job on a *final* failure.
 *
 * Never on an attempt that will be retried: an apology for a render that then
 * succeeds is worse than no email, and the message written into the
 * conversation follows the same rule a few lines from where this is called.
 */
export async function tellThemItDidNotFinish(input: {
  userId: string;
  jobId: string;
  projectId: string;
  projectTitle: string | null;
  reason: string;
}): Promise<void> {
  await tell(
    input.userId,
    "render.failed",
    input.jobId,
    renderFailed(input.projectTitle ?? "your project", input.projectId, input.reason),
  );
}

/**
 * And once per scheduled post that did not go out.
 *
 * Nothing told anybody at all before this. The console counted every failure;
 * the person whose post it was found out by looking at their own feed, or did
 * not. The shape of it is what makes a letter the right surface rather than a
 * badge: somebody schedules a week and closes the tab, and an account whose
 * authorisation was revoked then fails thirty posts one at a time, at their
 * hours, over seven days — thirty slots on a content calendar that quietly did
 * not happen, and no screen they were ever going to be looking at.
 *
 * Deduplicated by post id, like everything else here: a post retried is not a
 * post apologised for twice.
 *
 * `missed` is deliberately included. "It was 40 minutes late so it was not
 * sent" is the same fact from the person's side — the slot passed and nothing
 * went out — and it is the one they are most likely to want to act on today.
 */
export async function tellThemAPostDidNotGoOut(input: {
  userId: string;
  postId: string;
  projectId: string;
  platform: string;
  handle: string | null;
  reason: string;
}): Promise<void> {
  await tell(
    input.userId,
    "post.failed",
    input.postId,
    postFailed(input.platform, input.handle, input.reason, input.projectId),
  );
}

/**
 * Find the address, hand the letter over, and never throw.
 *
 * `send` already returns an outcome rather than raising, and it chooses the
 * language itself from what this person has told us and then from what they
 * do. What is caught here is the address read in front of it, which is an
 * ordinary database call and can fail like any other.
 *
 * "Already sent" and "no provider configured" are not warned about: the first
 * is this working — a worker that restarted mid-loop finds the claim already
 * taken — and the second is a deployment that has decided not to send mail,
 * which the package says once at info and does not repeat.
 */
async function tell(userId: string, event: string, reference: string, letter: Letter): Promise<void> {
  try {
    const to = await addressFor(userId);
    if (!to) return;
    const outcome = await send({ userId, to, kind: "account", event, reference, letter });
    if (!outcome.sent && outcome.because !== "already-sent" && outcome.because !== "not-configured") {
      log.warn({ event, reference, because: outcome.because }, "could not tell them what happened");
    }
  } catch (error) {
    log.warn({ err: error, event, reference }, "could not tell them about a render");
  }
}
