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

/*
  Why this is a package rather than a file in the API server.

  It was written there, for the billing webhook, and that was the right place
  for the first three letters. Then the fourth turned out to be "your edit is
  ready" — the one somebody is most obviously owed, because a render takes
  minutes and the person who asked for it is by design somewhere else when it
  lands. Only the *worker* knows a render finished, and the worker is a separate
  deployment that must not import the API server's modules.

  The alternatives were both worse. A second sender in the worker means two
  copies of the deduplication, and the whole argument of `mail_sends` is that
  there is exactly one place that decides whether a message has already gone. An
  internal HTTP call from the worker to the API means an authenticated endpoint
  whose only caller is us, on a serverless function, to save a move.

  So it moved, and `artifacts/api-server/src/lib/mail.ts` re-exports it: every
  existing caller, and the suite that reads it, are untouched.
*/

/**
 * Where this module's lines go.
 *
 * Injected rather than imported, because the two deployments have different
 * loggers and neither belongs in a shared package. Silent by default: a
 * library that writes to stdout on its own is a library that appears in the
 * logs of a process that never called it.
 */
export interface MailLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

let logger: MailLog = { info: () => {}, warn: () => {} };

/** Called once, at startup, by whichever process is doing the sending. */
export function logMailWith(log: MailLog): void {
  logger = log;
}

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
 * There is now. `artifacts/api-server/src/routes/mail.ts` serves the token,
 * `artifacts/editly/src/pages/unsubscribe.tsx` is the screen it lands on, and
 * this flag is what connects them to the sender.
 *
 * It was `false` for the whole life of this module, and `send` refused `news`
 * outright while it was — which is why this is a flag and not a comment. An
 * unsubscribe link is not a nicety to add in the week after the first
 * newsletter; a newsletter without one is unlawful in most of the places this
 * product will be read, and "we will add it next sprint" is the sentence that
 * ends with a complaint. The split between the two kinds existed here from the
 * first day precisely so that turning it on could be one line.
 *
 * It stays a constant rather than becoming a check of something at runtime,
 * because the property it names is "somebody built the way out", and that is
 * decided by a commit. `tools/mail-test.mjs` asserts the route and the screen
 * are both really there, so this cannot become true on its own.
 */
export const UNSUBSCRIBE_ROUTE_EXISTS = true;

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
export function unsubscribeLink(token: string): string {
  return `${appOrigin()}/unsubscribe/${token}`;
}

/**
 * The address a mail client posts to for one-click, which is not the same URL.
 *
 * `List-Unsubscribe-Post` means the provider sends a POST with nobody watching,
 * so it goes straight to the API rather than to a page that would have to run
 * JavaScript to do anything.
 */
export function oneClickEndpoint(token: string): string {
  return `${appOrigin()}/api/mail/unsubscribe/${token}`;
}

function appOrigin(): string {
  return (process.env["APP_ORIGIN"] ?? "https://app.editlyai.io").replace(/\/+$/, "");
}

function withUnsubscribe(body: string, token: string | null, language: MailLanguage): string {
  if (!token) return body;
  // The page, not the endpoint. A link in an email is followed by mail
  // scanners, link previewers and antivirus proxies before the person ever
  // sees it, so the URL a letter carries must not be one that acts.
  const link = unsubscribeLink(token);
  return language === "ar"
    ? `${body}\n\n--\nلإيقاف رسائل الأخبار: ${link}\nرسائل الحساب ستبقى تصلك.`
    : `${body}\n\n--\nTo stop these updates: ${link}\nAccount messages will still reach you.`;
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
        /*
          The headers Gmail and Yahoo require of anybody sending bulk mail.

          `List-Unsubscribe` puts a native "unsubscribe" control in the client's
          own chrome, above the message, which is the one a person actually
          finds. Without it the alternative they reach for is the spam button,
          and enough of those costs the domain its deliverability — including
          for the account mail, which is the half nobody can opt out of.

          `One-Click` means the provider POSTs the URL itself with nobody
          watching, so that one points at the API and not at the page. Only on
          news: putting an unsubscribe header on a receipt tells a client the
          message is marketing, which is the wrong answer for a letter saying a
          payment failed.
        */
        ...(token
          ? {
              headers: {
                "List-Unsubscribe": `<${oneClickEndpoint(token)}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              },
            }
          : {}),
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

/**
 * A link into the app, built once.
 *
 * Read per call rather than at import for the reason `allowed-origins.ts`
 * gives: a build-time substitution once made a configured value unreadable at
 * runtime, and a mail whose only link is wrong is worse than one with no link.
 */
function appLink(path: string): string {
  const origin = (process.env["APP_ORIGIN"] ?? "https://app.editlyai.io").replace(/\/+$/, "");
  return `${origin}${path}`;
}

/**
 * The one somebody is actually waiting for.
 *
 * A render takes minutes, so the person who asked for it is — by design, and
 * not by accident — somewhere else by the time it lands. Until this existed the
 * only way to learn that an edit had finished was to have left the tab open,
 * which is the opposite of what a queue is for.
 *
 * What it says is what they need to decide whether to come back now: which
 * project, how long the result is, and one link. Not the render notes: those
 * are in the conversation, they are long, and an email that reproduces them is
 * an email nobody finishes.
 */
export function renderFinished(project: string, projectId: string, seconds: number | null): Letter {
  const link = appLink(`/project/${projectId}`);
  const length =
    typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
      ? `${Math.round(seconds)}`
      : null;
  return {
    en: {
      subject: `Your edit is ready: ${project}`,
      body:
        `The edit you asked for on "${project}" has finished` +
        (length ? `, and it is ${length} seconds long` : "") +
        `.\n\n` +
        `Open it here: ${link}\n\n` +
        `The notes on what was done to it are in the conversation, on that page.`,
    },
    ar: {
      subject: `تعديلك جاهز: ${project}`,
      body:
        `انتهى التعديل الذي طلبته على «${project}»` +
        (length ? `، وطوله ${length} ثانية` : "") +
        `.\n\n` +
        `افتحه من هنا: ${link}\n\n` +
        `وملاحظات ما جرى عليه في المحادثة، على تلك الصفحة.`,
    },
  };
}

/**
 * And the one nobody wants to send.
 *
 * Only on a *final* failure, which the worker decides — an apology for a render
 * that then succeeds on its next attempt is worse than no email at all, and the
 * message written into the conversation follows the same rule three lines away
 * from where this is queued.
 *
 * It says outright that nothing was charged, because that is the first question
 * anybody has and the one they would otherwise open a support conversation to
 * ask. The reason is quoted rather than paraphrased: it comes from ffmpeg or
 * from infrastructure, in English, and inventing an Arabic reason we did not
 * write would be a different claim about what went wrong.
 */
export function renderFailed(project: string, projectId: string, reason: string): Letter {
  const link = appLink(`/project/${projectId}`);
  const said = reason.trim().slice(0, 300);
  return {
    en: {
      subject: `That edit did not finish: ${project}`,
      body:
        `The edit on "${project}" stopped before it finished.\n\n` +
        (said ? `What went wrong: ${said}\n\n` : "") +
        `You have not been charged for it, and your video is untouched.\n\n` +
        `You can ask for it again here: ${link}`,
    },
    ar: {
      subject: `لم يكتمل التعديل: ${project}`,
      body:
        `توقّف التعديل على «${project}» قبل أن ينتهي.\n\n` +
        (said ? `ما الذي حدث: ${said}\n\n` : "") +
        `ولم يُحتسب عليك شيء، وفيديوك كما هو.\n\n` +
        `تستطيع طلبه مرّة أخرى من هنا: ${link}`,
    },
  };
}

/**
 * Where to send it, when the caller knows a person and not an address.
 *
 * The billing webhook never needed this: Freemius hands the email over in the
 * payload. The worker has a `user_id` and nothing else, and there is no address
 * anywhere in this schema — identity lives in `auth.users`, which the
 * application role has no USAGE on. So it goes through
 * `public.email_for_user`, a SECURITY DEFINER function that answers this one
 * question with its owner's rights. See `0042_a_way_to_reach_them.sql`.
 *
 * Null on anything at all: a missing function on a deployment that has not run
 * the migration, a deleted account, a read that failed. Every caller treats
 * null as "there is nobody to tell", which is the honest reading of all three.
 */
export async function addressFor(userId: string): Promise<string | null> {
  try {
    const found = await db.execute<{ email: string | null }>(sql`
      select public.email_for_user(${userId}) as email
    `);
    const email = found.rows[0]?.email ?? null;
    return email && email.includes("@") ? email : null;
  } catch (error) {
    logger.warn({ err: error, userId }, "could not look up an address");
    return null;
  }
}
