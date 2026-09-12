/**
 * The rules a promo code is judged by, with no database in sight.
 *
 * Everything here is a pure function of what was typed and what the account
 * already has, so the interesting questions — can a code be stacked on a paid
 * subscription, can a grant quietly downgrade somebody, what does the last day
 * of a twelve-month grant that started on the 31st of January fall on — are
 * answerable in a test that needs no Postgres and no server.
 *
 * The route on top of this owns exactly two things this file cannot: the
 * atomic claim of a seat, and the writing.
 *
 * **A code is a grant, not a discount, and that is a limit rather than a
 * preference.** What is built here makes a plan free: it writes the plan onto
 * the account with a date it runs out, and no payment happens at all. A code
 * that takes $29 down to $9 is a different kind of thing — a rule about a
 * charge — and the charge is made by the merchant of record at checkout, not by
 * anything in this repository. There is no honest way to write that on this
 * side: we would be recording a smaller number while the card was charged the
 * larger one. So a percentage-off coupon is created wherever checkout lives,
 * and this file is where somebody looking for it in the code will find out.
 */
import { PLAN_LIMITS, planKeyFrom, type PlanKey } from "./plan-limits";

/** Cheapest first, so a grant can be compared against what somebody already has. */
const RANK: Record<PlanKey, number> = { free: 0, creator: 1, pro: 2, studio: 3 };

/**
 * The longest and shortest a code may be.
 *
 * Short enough to be said out loud in a video, long enough that guessing is
 * not a strategy. A generated code is ten characters of a thirty-two letter
 * alphabet, which is fifty bits — unreachable at five attempts per account per
 * ten minutes. The floor of four exists for the other kind: a word somebody
 * chooses on purpose, like `NOAH`, whose secrecy was never the point because it
 * is going to be said in a video anyway. What protects a code like that is its
 * seat count, not its length.
 */
export const CODE_MIN = 4;
export const CODE_MAX = 32;

/**
 * What a code is, once the punctuation somebody typed is gone.
 *
 * A person reading a word off a screen types it in whatever case they like and
 * puts a dash where they saw a space. None of that is information, so none of
 * it is stored: both the mint and the redeem run their input through here, and
 * the stored form is the only form ever compared.
 */
export function normaliseCode(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .normalize("NFKC")
    /*
      Arabic-Indic digits, read as the digits they are.

      NFKC does not do this — it folds ligatures and width, not scripts — so a
      code typed on an Arabic keyboard arrived with every digit stripped by the
      filter below and failed as "no such code". This product's first market is
      exactly the people whose keyboard produces ٣ when they press the key under
      the 3, and a code is a thing people copy by looking at it.

      Both ranges: U+0660 is the Arabic-Indic set and U+06F0 the extended one
      Persian and Urdu keyboards produce, which look the same on screen.
    */
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, CODE_MAX);
}

/** Whether a normalised code is one this product will store. */
export function codeUsable(code: string): boolean {
  return code.length >= CODE_MIN && code.length <= CODE_MAX;
}

/**
 * The alphabet a generated code is drawn from.
 *
 * No `O`, `0`, `I`, `1` — a code exists to be read off a screen and typed into
 * a phone, and those four are the ones people get wrong. `normaliseCode` does
 * not correct them either, on purpose: silently turning a typed `0` into `O`
 * would make `EDITLY0` and `EDITLYO` the same code, and the mint is free to
 * avoid the ambiguity rather than the redeem having to guess through it.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * A code nobody has to think of.
 *
 * `randomBytes`, not `Math.random`: this is the only credential in the product
 * a stranger can attempt by typing, and a predictable one is a free plan for
 * whoever reads the generator. The modulo bias across a 32-letter alphabet in
 * 256 is none — 256 divides evenly by 32 — so the simple form is also the
 * correct one here.
 */
export function generateCode(bytes: Uint8Array, length = 10): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  return out;
}

/**
 * The last moment a grant of `months` months, made now, is still good for.
 *
 * Calendar months rather than thirty-day blocks, because the promise made to
 * the person is "a year", and `setUTCMonth` does the arithmetic the way a
 * calendar does — with one exception it gets wrong in the direction nobody
 * wants. The 31st of January plus one month is the 31st of February, which
 * JavaScript rolls forward to the 3rd of March: a grant that is a couple of
 * days longer than it said. Clamping to the last day of the target month is
 * the honest reading of "a month later", and it is the one every calendar
 * application makes.
 */
export function grantEnd(months: number, from: Date): Date {
  const day = from.getUTCDate();
  const end = new Date(from.getTime());
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + months);
  const lastOfTarget = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastOfTarget));
  return end;
}

/** The state of a code as the database holds it, reduced to what the rule needs. */
export interface CodeRow {
  code: string;
  plan: string;
  months: number;
  maxRedemptions: number;
  redeemedCount: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

/** The state of the account asking, likewise. */
export interface AccountState {
  plan: string;
  planExpiresAt: Date | null;
  licenseId: string | null;
  /** Whether this account has already used this particular code. */
  usedThisCode: boolean;
}

export interface Refusal {
  status: number;
  /** A key, so the browser can say it in the reader's own language. */
  reason:
    | "unknown"
    | "revoked"
    | "expired"
    | "used-up"
    | "already-used"
    | "paid-account"
    | "not-an-upgrade";
  /** The same thing in English, for the log and for anyone calling the API directly. */
  error: string;
}

/**
 * Whether this account may redeem this code, and why not.
 *
 * Every refusal here is deliberately specific, including the ones that tell a
 * stranger something true about a code they do not own. That is a trade made
 * with the door's rate limit rather than with vagueness: "that code has been
 * used" and "no such code" are the same answer to somebody guessing at a
 * hundred codes an hour, and completely different answers to the affiliate
 * standing in front of a code they were promised.
 *
 * The order matters. The account's own state is judged before the code is
 * spent, so nothing burns a seat on a redemption that was going to be refused.
 */
export function refuseRedemption(
  code: CodeRow | null,
  account: AccountState,
  now: Date,
): Refusal | null {
  if (!code) {
    return { status: 404, reason: "unknown", error: "That is not a code we know." };
  }
  if (code.revokedAt) {
    return { status: 410, reason: "revoked", error: "That code has been withdrawn." };
  }
  if (code.expiresAt && code.expiresAt.getTime() <= now.getTime()) {
    return { status: 410, reason: "expired", error: "That code has passed its date." };
  }
  if (account.usedThisCode) {
    return { status: 409, reason: "already-used", error: "This account has already used that code." };
  }
  if (code.redeemedCount >= code.maxRedemptions) {
    return { status: 409, reason: "used-up", error: "That code has already been used." };
  }

  /*
    Never onto a paid subscription, and this is the refusal that matters most.

    A licence behind a paid plan, with no end date, is somebody's card being
    charged every month. If a code wrote its plan and its end date over that
    row, the account would keep being charged and would drop to free twelve
    months later — the product taking away something still being paid for, from
    a person who did nothing but try a code they were given.

    **What a licence id alone does not mean.** The condition was
    `licenseId && !planExpiresAt`, which reads as "is paying" and is not: that
    column is the record of what the merchant of record last said about this
    account, and it outlives what it said — a cancellation, a refund, or a test
    event that granted nothing. The owner's own row is exactly that shape, free
    with a licence id from a test, and it was turned away as a paying customer
    whose card must not be disturbed. Nobody is charged for free, and a row
    serving nothing has nothing for a grant to take away.

    So the question is what that licence is actually doing right now: holding a
    paid plan, with no date on it. That is the row a grant must not touch.
  */
  const holding = planKeyFrom(account.plan);
  if (account.licenseId && !account.planExpiresAt && holding !== "free") {
    return {
      status: 409,
      reason: "paid-account",
      error:
        "This account already has a paid subscription, and a code cannot be added to one. It would not reduce what you are charged.",
    };
  }

  /*
    And never downwards. A live grant of Pro meeting a Creator code must not
    become Creator — the person redeeming is trying to gain something, and the
    only reading of a downgrade is that we took it.
  */
  const granting = planKeyFrom(code.plan);
  const stillHeld = !account.planExpiresAt || account.planExpiresAt.getTime() > now.getTime();
  if (stillHeld && RANK[granting] <= RANK[holding] && RANK[holding] > 0) {
    return {
      status: 409,
      reason: "not-an-upgrade",
      error: `This account is already on ${holding}, which is not smaller than what that code gives.`,
    };
  }

  return null;
}

/** What a successful redemption writes. Separated so the route does no arithmetic. */
export function grantFrom(code: CodeRow, now: Date): { plan: PlanKey; expiresAt: Date } {
  return { plan: planKeyFrom(code.plan), expiresAt: grantEnd(code.months, now) };
}

/**
 * Which plans a code may grant.
 *
 * Not free, and the reason is not tidiness: a code granting free would write an
 * expiry date onto a free account, and a free plan that "runs out" is a state
 * nothing in this product means anything by.
 */
export function grantablePlans(): PlanKey[] {
  return (Object.keys(PLAN_LIMITS) as PlanKey[]).filter((plan) => plan !== "free");
}
