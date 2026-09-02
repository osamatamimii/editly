/**
 * The product could not talk to the people using it.
 *
 * A search across the API and the worker for any way of sending an email
 * returned nothing at all. No `resend`, no `nodemailer`, no `sendMail`, no
 * SMTP. Every moment where a decision gets made was silent: a subscription
 * renewed, a card failed, minutes ran out, a scheduled post did not go. A
 * silent card failure in particular is a subscription that has already been
 * lost by the time anybody notices.
 *
 * ## Four rules, and each of them is a bug that has already happened somewhere
 *
 * **Nothing is ever sent twice.** A post that goes out twice cannot be taken
 * back, and neither can an email. Every send is claimed in `mail_sends` under
 * a unique key of `(user, event, reference)` before the request is made, so a
 * webhook Freemius redelivers, or a worker that restarts mid-loop, finds the
 * row already there and sends nothing. Without that, a redelivery is two
 * identical emails, which is the fastest route to a spam complaint on a domain
 * with no reputation yet.
 *
 * **Account mail and marketing mail are different things from the first day.**
 * A receipt is not an advertisement, and unsubscribing from an advertisement
 * must not stop a receipt. They are separated here rather than later, because
 * merging them later is nothing and separating them later is a migration and
 * an apology. Marketing carries an unsubscribe link and is refused for anybody
 * who has used it; a transactional message ignores that flag entirely, and the
 * suite checks both directions.
 *
 * **Both languages, always.** Every other sentence this product writes exists
 * in Arabic and English and this is no different. The language comes from the
 * person's own preference, and where they have not set one it is taken from
 * the language they have actually been asking us in — their most recent
 * render — rather than from the words in the email, which is a circular way of
 * deciding.
 *
 * **A failure to send never fails the thing it was reporting on.** Same rule
 * as `review.ts`: best effort, a line in the log, and the caller carries on.
 * Nobody's render, payment or account change is worth failing because a
 * mail provider had a bad minute.
 *
 * ## The provider, and a warning
 *
 * Resend's HTTP API, with `RESEND_API_KEY`. Not SMTP through Supabase, which
 * routes to the same company and has already broken silently once when the key
 * was rotated and not updated everywhere it had been copied. And explicitly
 * not the old exposed key, which has still not been deleted: this reads one
 * variable, and a deployment that has not set it sends nothing and says so.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Who it comes from. A real address on our own domain, not a no-reply. */
const FROM = process.env["MAIL_FROM"]?.trim() || "Editly <hello@editlyai.io>";

export type MailLanguage = "en" | "ar";

/**
 * Which kind of message this is, and it decides two things.
 *
 * `account` is what somebody asked for by having an account: a payment, a
 * plan, a limit they hit. It is sent whatever their marketing preference is,
 * because unsubscribing from news is not a request to stop being told that a
 * card was declined.
 *
 * `news` is everything else, carries an unsubscribe link, and is refused for
 * anybody who has ever used one.
 */
export type MailKind = "account" | "news";

export interface Message {
  subject: string;
  /** Plain text. One column, no images, nothing that needs a designer. */
  body: string;
}

export interface Letter {
  /** Both halves, at the point of declaration, so neither can be forgotten. */
  en: Message;
  ar: Message;
}

export interface Send {
  userId: string;
  to: string;
  kind: MailKind;
  /** What happened. Part of the uniqueness key, so name it stably. */
  event: string;
  /**
   * Which instance of that event: an event id, a month, a project. Part of the
   * key, and the whole reason "we already told them" is answerable.
   */
  reference: string;
  letter: Letter;
}

export type SendOutcome =
  | { sent: true }
  | {
      sent: false;
      because:
        | "already-sent"
        | "not-configured"
        | "unsubscribed"
        | "no-address"
        | "no-way-out"
        | "refused";
    };

/**
 * Whether there is a door out of the marketing list yet.
 *
 * There is not. Every message this product sends today is an account message,
 * and the unsubscribe endpoint that a marketing message legally requires has
 * not been built — so rather than leaving that as a comment somebody will miss,
 * `send` refuses `news` outright until this is true.
 *
 * That refusal is the point. An unsubscribe link is not a nicety to add in the
 * week after the first newsletter; a newsletter without one is unlawful in most
 * of the places this product will be read, and "we will add it next sprint" is
 * the sentence that ends with a complaint. The split between the two kinds
 * exists here from the first day precisely so that this can be a flag rather
 * than a migration.
 */
export const UNSUBSCRIBE_ROUTE_EXISTS = false;

export const mailConfigured = (): boolean => Boolean(process.env["RESEND_API_KEY"]?.trim());

/**
 * Their language, from what they have told us and then from what they do.
 *
 * The preference first. Failing that, the language of their most recent render,
 * which is a real signal already sitting in the database: somebody who has
 * asked this product for things in Arabic five times does not want an English
 * receipt. English only when there is nothing at all to go on.
 *
 * Deliberately not read from the message: choosing the language of an email
 * from the language of its own contents is a circle, and it is how a product
 * ends up writing to everybody in whatever the template happened to be in.
 */
export async function languageFor(userId: string): Promise<MailLanguage> {
  try {
    const chosen = await db.execute<{ language: string | null }>(sql`
      select language from mail_settings where user_id = ${userId} limit 1
    `);
    const preference = chosen.rows[0]?.language;
    if (preference === "ar" || preference === "en") return preference;

    const recent = await db.execute<{ language: string | null }>(sql`
      select language from jobs where user_id = ${userId}
       order by created_at desc limit 1
    `);
    return recent.rows[0]?.language === "ar" ? "ar" : "en";
  } catch (error) {
    logger.warn({ err: error, userId }, "could not read a language preference; writing in English");
    return "en";
  }
}

/** Whether this person has said they want no more news. Account mail ignores it. */
async function unsubscribed(userId: string): Promise<boolean> {
  try {
    const found = await db.execute<{ news_opt_out: boolean }>(sql`
      select news_opt_out from mail_settings where user_id = ${userId} limit 1
    `);
    return found.rows[0]?.news_opt_out === true;
  } catch {
    /*
      A read that failed is not consent. On this one question the safe answer is
      the restrictive one: a person who unsubscribed and gets another newsletter
      because a query timed out has been ignored, and the law does not have an
      exception for that.
    */
    return true;
  }
}

/**
 * The unsubscribe line, in both languages, and only on news.
 *
 * The token is the row's own, minted when the settings row is created, so the
 * link identifies the preference and not the person: it cannot be turned back
 * into an account id, an email or a session.
 */
function withUnsubscribe(body: string, token: string | null, language: MailLanguage): string {
  if (!token) return body;
  const link = `${(process.env["APP_ORIGIN"] ?? "https://app.editlyai.io").replace(/\/+$/, "")}/api/mail/unsubscribe/${token}`;
  return language === "ar"
    ? `${body}\n\n—\nلإيقاف رسائل الأخبار: ${link}\nرسائل الحساب ستبقى تصلك.`
    : `${body}\n\n—\nTo stop these updates: ${link}\nAccount messages will still reach you.`;
}

/**
 * Claim the right to send, in one statement.
 *
 * The insert *is* the lock. Checking for a row and then writing one leaves a
 * window two workers can both walk through, and the failure mode of that window
 * is the exact thing this table exists to prevent. `ON CONFLICT DO NOTHING`
 * with a returning clause answers "was it me who claimed it" atomically.
 */
async function claim(send: Send): Promise<boolean> {
  const taken = await db.execute<{ user_id: string }>(sql`
    insert into mail_sends (user_id, event, reference, kind)
         values (${send.userId}, ${send.event}, ${send.reference}, ${send.kind})
    on conflict (user_id, event, reference) do nothing
      returning user_id
  `);
  return taken.rows.length > 0;
}

/** Let go of a claim that never became an email, so it can be tried again. */
async function release(send: Send): Promise<void> {
  await db
    .execute(sql`
      delete from mail_sends
       where user_id = ${send.userId} and event = ${send.event} and reference = ${send.reference}
         and sent_at is null
    `)
    .catch(() => {
      /* Leaving the claim is the safe direction: at worst one message is not
         sent. The other direction sends two. */
    });
}

/**
 * Send one message, once, and never throw.
 *
 * Every path returns an outcome instead of raising, because every caller is in
 * the middle of doing something more important than this: applying a payment,
 * refusing a render, finishing a job. A mail provider having a bad minute is
 * not a reason for any of those to fail.
 */
export async function send(message: Send, fetchImpl: typeof fetch = fetch): Promise<SendOutcome> {
  try {
    if (!message.to.includes("@")) return { sent: false, because: "no-address" };
    if (!mailConfigured()) {
      /*
        Said once, at info. A deployment with no key has decided not to send
        mail, which is a choice rather than an incident — but unlike a missing
        vision key this one is worth a line, because a product that silently
        stopped emailing its customers looks exactly like a product with nothing
        to say.
      */
      logger.info({ event: message.event }, "no mail key on this deployment, so nothing was sent");
      return { sent: false, because: "not-configured" };
    }
    if (message.kind === "news") {
      if (!UNSUBSCRIBE_ROUTE_EXISTS) {
        logger.warn(
          { event: message.event },
          "a marketing message was refused because there is no unsubscribe route yet",
        );
        return { sent: false, because: "no-way-out" };
      }
      if (await unsubscribed(message.userId)) return { sent: false, because: "unsubscribed" };
    }

    if (!(await claim(message))) return { sent: false, because: "already-sent" };

    const language = await languageFor(message.userId);
    const letter = message.letter[language];
    const token = message.kind === "news" ? await unsubscribeToken(message.userId) : null;

    const response = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env["RESEND_API_KEY"]?.trim() ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [message.to],
        subject: letter.subject,
        text: withUnsubscribe(letter.body, token, language),
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      const said = (await response.text().catch(() => "")).slice(0, 200);
      logger.warn({ event: message.event, status: response.status, said }, "the mail provider refused a message");
      await release(message);
      return { sent: false, because: "refused" };
    }

    await db
      .execute(sql`
        update mail_sends set sent_at = now()
         where user_id = ${message.userId} and event = ${message.event} and reference = ${message.reference}
      `)
      .catch(() => {
        /* It went out. A row that says "claimed" and not "sent" is still a row
           that stops a second copy, which is the property that matters. */
      });
    return { sent: true };
  } catch (error) {
    logger.warn({ err: error, event: message.event }, "a message could not be sent, and nothing else failed");
    await release(message).catch(() => {});
    return { sent: false, because: "refused" };
  }
}

/** The token for this person's unsubscribe link, made on first use. */
async function unsubscribeToken(userId: string): Promise<string | null> {
  try {
    const row = await db.execute<{ token: string }>(sql`
      insert into mail_settings (user_id) values (${userId})
      on conflict (user_id) do update set updated_at = now()
        returning token
    `);
    return row.rows[0]?.token ?? null;
  } catch (error) {
    logger.warn({ err: error, userId }, "could not mint an unsubscribe token");
    return null;
  }
}

// ── The letters ─────────────────────────────────────────────────────────────
/*
  Written here rather than fetched from a template service, and as plain text.

  A person reading "your card was declined" needs one sentence and one link,
  and every part of an HTML email — the images, the tracking pixel, the
  rendering differences between six clients — is a cost paid for nothing at
  this size. Plain text also cannot be the thing that lands a new domain in a
  spam folder.

  Every letter is a pair. `Letter` requires both halves at the point of
  declaration for the same reason `say()` does in the matcher: a template that
  *can* be written without its Arabic is one that *will* be, on the branch
  nobody exercised.
*/

export function planChanged(plan: string): Letter {
  return {
    en: {
      subject: `Your Editly plan is now ${plan}`,
      body:
        `Your plan changed to ${plan}.\n\n` +
        `Your minutes and upload limits follow the plan, and everything you have already made is untouched.\n\n` +
        `You can see what the plan includes on your account page.`,
    },
    ar: {
      subject: `خطّتك في Editly صارت ${plan}`,
      body:
        `تغيّرت خطّتك إلى ${plan}.\n\n` +
        `دقائقك وحدود الرفع تتبع الخطّة، وكل ما صنعته سابقًا كما هو.\n\n` +
        `تجد ما تشمله الخطّة في صفحة حسابك.`,
    },
  };
}

export function paymentFailed(): Letter {
  return {
    en: {
      subject: "Your last Editly payment did not go through",
      body:
        `The card on your subscription was declined, so the payment did not complete.\n\n` +
        `Nothing has been deleted and nothing has been cancelled yet. Updating the card on your account page ` +
        `is all it takes.\n\n` +
        `If you meant to cancel, you can ignore this.`,
    },
    ar: {
      subject: "لم تتمّ آخر دفعة في Editly",
      body:
        `رُفضت البطاقة المرتبطة باشتراكك، فلم تتمّ الدفعة.\n\n` +
        `لم يُحذف شيء ولم يُلغَ شيء بعد. تحديث البطاقة من صفحة حسابك يكفي.\n\n` +
        `وإن كنت تقصد الإلغاء، فتجاهل هذه الرسالة.`,
    },
  };
}

export function minutesRunOut(plan: string): Letter {
  return {
    en: {
      subject: "You have used this month's Editly minutes",
      body:
        `The minutes on your ${plan} plan are used up for this month, so new renders will not start until it resets.\n\n` +
        `Everything you have already made is still there, and so is everything already queued.\n\n` +
        `A larger plan starts the next render immediately.`,
    },
    ar: {
      subject: "استهلكت دقائق هذا الشهر في Editly",
      body:
        `انتهت دقائق خطّة ${plan} لهذا الشهر، فلن يبدأ تصيير جديد حتى تتجدّد.\n\n` +
        `كل ما صنعته باقٍ، وكل ما في الطابور كذلك.\n\n` +
        `وخطّة أكبر تبدأ التصيير التالي فورًا.`,
    },
  };
}
