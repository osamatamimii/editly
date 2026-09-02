/**
 * The way off the list.
 *
 * `lib/mail` has refused to send a single marketing message since it was
 * written, because `UNSUBSCRIBE_ROUTE_EXISTS` was `false` and there was nothing
 * here to make it true. That refusal was the right call and it is the reason
 * this file is small: the split between account mail and news existed from the
 * first day so that this could be a flag rather than a migration.
 *
 * ## Why the token and nothing else
 *
 * The person clicking is in an email client. They have no session, they may be
 * on a different device, and asking them to sign in to stop receiving mail is
 * how a legal requirement becomes a complaint. So the token in the link is the
 * whole authorisation, and it is deliberately meaningless: a random string on
 * the `mail_settings` row, minted on first use. It cannot be turned back into
 * an account id, an email address or a session, and holding one lets you do
 * exactly one thing.
 *
 * ## Why the GET does not unsubscribe
 *
 * Because a link in an email is fetched by things that are not the person.
 * Corporate mail scanners, link previewers and antivirus proxies all follow
 * every URL in every message before it reaches an inbox. A `GET` that
 * unsubscribes would quietly unsubscribe people who never opened the letter,
 * and nothing would report it: the mail simply stops, and they conclude the
 * product forgot them.
 *
 * So the `GET` reads, the `POST` acts, and the link in the letter points at a
 * page that does the `POST` on a press. One exception, and it is the one the
 * mail providers require: a `POST` straight to this route with no page in
 * between is what `List-Unsubscribe-Post: List-Unsubscribe=One-Click` means,
 * and Gmail and Yahoo both demand it of anybody sending bulk mail. A POST from
 * a scanner is not a thing that happens.
 */
import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { rateLimitByIp, LIMITS } from "../lib/rate-limit";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/**
 * What a token may look like.
 *
 * Minted as a uuid with the dashes removed, so thirty-two hex characters. The
 * shape is checked before the database is touched: a malformed token costs a
 * regex rather than a query, and a parameter that reaches SQL as a wildcard is
 * a parameter that never should have got that far.
 */
const TOKEN = /^[0-9a-f]{32}$/;

/**
 * The same answer for a token that is wrong and one that is unknown.
 *
 * Telling them apart turns this endpoint into a way to test whether a string is
 * a live token, one guess at a time. There is nothing behind it worth guessing
 * for, and the sentence a person needs is the same either way: this link no
 * longer works, and here is what to do instead.
 */
const UNKNOWN = {
  known: false as const,
  message:
    "This link is not one we recognise. It may be from an old message, or it may have been cut short by an email client. The link in your most recent email will work.",
};

/**
 * Is this a live token, and what is the current setting?
 *
 * Read only. The page in front of it renders from this, so somebody arrives at
 * a screen that already knows whether they are subscribed rather than one that
 * asks them to press a button to find out.
 */
router.get("/mail/unsubscribe/:token", rateLimitByIp(LIMITS.unsubscribe), async (req, res): Promise<void> => {
  const token = String(req.params["token"] ?? "");
  if (!TOKEN.test(token)) {
    res.status(404).json(UNKNOWN);
    return;
  }

  try {
    const found = await db.execute<{ news_opt_out: boolean }>(sql`
      select news_opt_out from mail_settings where token = ${token} limit 1
    `);
    const row = found.rows[0];
    if (!row) {
      res.status(404).json(UNKNOWN);
      return;
    }
    res.json({ known: true, subscribed: !row.news_opt_out });
  } catch (error) {
    logger.error({ err: error }, "could not read an unsubscribe token");
    res.status(503).json({
      known: false,
      message: "We could not check that link just now. Please try again in a moment.",
    });
  }
});

/**
 * Stop the news, or start it again.
 *
 * Idempotent on purpose: somebody who presses twice, or whose mail client
 * fetches the one-click URL twice, gets the same answer both times rather than
 * being toggled back onto a list they just left.
 */
router.post("/mail/unsubscribe/:token", rateLimitByIp(LIMITS.unsubscribe), async (req, res): Promise<void> => {
  const token = String(req.params["token"] ?? "");
  if (!TOKEN.test(token)) {
    res.status(404).json(UNKNOWN);
    return;
  }

  /*
    `resubscribe: true` is the only way back on, and it exists because the
    screen this serves offers it.

    A person who unsubscribes by accident — a mis-tap, a scanner they did not
    know about, a change of mind an hour later — otherwise has no route back
    except to write in. The default is off, so a bare POST from a one-click
    header can only ever unsubscribe.
  */
  const optOut = (req.body as { resubscribe?: unknown } | undefined)?.resubscribe !== true;

  try {
    const updated = await db.execute<{ token: string }>(sql`
      update mail_settings
         set news_opt_out = ${optOut}, updated_at = now()
       where token = ${token}
       returning token
    `);
    if (updated.rows.length === 0) {
      res.status(404).json(UNKNOWN);
      return;
    }
    // No account id and no address in the line: this is the one place in the
    // product where the whole point of the identifier is that it names nobody.
    logger.info({ optOut }, "a mail preference was changed from an emailed link");
    res.json({ known: true, subscribed: !optOut });
  } catch (error) {
    logger.error({ err: error }, "could not change a mail preference");
    res.status(503).json({
      known: false,
      message: "We could not change that just now, and nothing was changed. Please try again in a moment.",
    });
  }
});

export default router;
