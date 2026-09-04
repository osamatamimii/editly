/**
 * Deciding whether an event that has already been verified should actually be
 * applied.
 *
 * `planFromEvent` answers "what does this event mean". This answers the
 * question nobody was asking: **is this event still true?**
 *
 * The distinction is the whole bug. A target-state write is idempotent — apply
 * `plan = pro` twice and you have Pro — and the comment above `planFromEvent`
 * correctly says so. But idempotence says nothing about *order*, and Freemius
 * retries deliveries. Upgrading Creator → Pro emits two events: the Pro licence
 * being created, and the Creator licence being cancelled. If the cancellation's
 * first delivery fails and is retried after the Pro event has landed, a blind
 * upsert writes free over Pro. The customer keeps paying $29 and gets the free
 * plan's watermark, and `PATCH /subscription` refuses upgrades by design, so
 * nothing in the product can put it back.
 *
 * Three rules, each refusing a different lie, and every one of them written so
 * that **missing information never causes a refusal**. Freemius does not
 * guarantee any of these fields, and a guard that fires on absence would drop
 * real payments — which is a far worse failure than the one being fixed.
 */

export type LedgerOutcome =
  | "applied"
  | "duplicate"
  | "stale"
  | "superseded-licence"
  | "no-account-yet"
  | "ignored";

export interface CurrentSubscription {
  plan: string;
  licenseId?: string | null;
  planSourceAt?: Date | string | null;
}

export interface IncomingEvent {
  /** What the event asks for. Null for events we recognise but do not act on. */
  plan: string | null;
  licenseId?: string | null;
  eventAt?: Date | string | null;
  /** True when this exact event id has been recorded before. */
  alreadySeen?: boolean;
}

function time(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export interface LedgerDecision {
  apply: boolean;
  outcome: LedgerOutcome;
  /** One sentence for the log line and for the `outcome` column. */
  reason: string;
}

export function decideApply(event: IncomingEvent, current: CurrentSubscription | null): LedgerDecision {
  if (event.alreadySeen) {
    return {
      apply: false,
      outcome: "duplicate",
      reason: "this exact event has been recorded before",
    };
  }

  if (event.plan === null) {
    return { apply: false, outcome: "ignored", reason: "not an event about access" };
  }

  if (!current) return { apply: true, outcome: "applied", reason: "no subscription state to compare against" };

  // Rule one: an event that predates the state we already hold is a retry that
  // lost a race, not news.
  //
  // Both sides must be known. `plan_source_at` is null on every row that
  // predates this column and on any plan set by a self-serve downgrade, and
  // Freemius does not promise a timestamp on every event. An unknown on either
  // side means we cannot order them, and "cannot order" must mean "apply" —
  // the alternative is silently dropping real payments.
  const incomingAt = time(event.eventAt);
  const currentAt = time(current.planSourceAt);

  /*
    Same second is not "after".

    Freemius timestamps are second-granularity — this module normalises
    "2026-08-15 14:02:11" a hundred lines down — and an upgrade emits its
    grant and the tidy-up of the licence it replaces *in the same second*.
    So `incomingAt < currentAt` was false for exactly the pair of events the
    rule was written for, and rule two below had to carry the whole load —
    which it cannot, because it needs a licence id on both sides and a
    `subscription.cancelled` payload has no `objects.license` at all.

    The result: customer upgrades Creator → Pro, the cancellation of the old
    Creator subscription lands second in the same second, and `free` is
    written over `pro`. They are charged $29 a month for five minutes and a
    watermark, `PATCH /subscription` refuses upgrades by design, and the
    billing_events row reads `applied`.

    A real cancellation happens strictly after the grant that set the paid
    plan; only the upgrade's own tidy-up arrives level with it. So a drop to
    free must be strictly newer, and everything else keeps the old rule.
  */
  const droppingToFree = event.plan === "free" && current.plan !== "free";
  // Narrowed to the one shape that cannot be told apart any other way: a drop
  // to free that does not say which licence it is about, against a plan that
  // does. A cancellation naming the live licence is a real cancellation
  // however close it lands, and one naming a different licence is already
  // refused by rule two below. Only the unattributable one needs the clock,
  // and for it "same second" means the upgrade's own tidy-up.
  const unattributable = droppingToFree && !event.licenseId && Boolean(current.licenseId);
  const orderable = incomingAt !== null && currentAt !== null;
  const notNews = orderable && (unattributable ? incomingAt <= currentAt : incomingAt < currentAt);
  if (notNews) {
    return {
      apply: false,
      outcome: "stale",
      reason: unattributable
        ? "this cancellation names no licence and is not newer than the event that granted the current plan"
        : "this event is older than the one that set the current plan",
    };
  }

  // Rule two: a cancellation of a licence that is not the one currently
  // granting access is a superseded licence being tidied up.
  //
  // This is the upgrade case exactly. It applies only when dropping *to* free —
  // an event that grants a plan is never refused on this basis, because a new
  // licence naturally carries a new id and refusing it would block every
  // upgrade. And it applies only when both licence ids are known.
  if (droppingToFree) {
    const incomingLicence = event.licenseId ?? null;
    const currentLicence = current.licenseId ?? null;
    if (incomingLicence && currentLicence && incomingLicence !== currentLicence) {
      return {
        apply: false,
        outcome: "superseded-licence",
        reason: "this cancellation is for a licence that no longer grants this plan",
      };
    }
  }

  return { apply: true, outcome: "applied", reason: "current" };
}

/**
 * Which licence this event is about, from wherever its shape puts it.
 *
 * It was read only from `objects.license`, which a `license.*` event carries
 * and a `subscription.cancelled` or `payment.refund` does not. So the
 * superseded-licence rule above — the one that stops a cancelled Creator
 * licence taking away a Pro plan — was skipped for exactly the events most
 * likely to need it, because it requires an id on both sides and one side was
 * always null.
 *
 * Freemius does carry the id on those shapes, one level down, under a
 * different name. Reading all three costs nothing and makes the rule reachable.
 */
export function licenceIdFrom(objects: Record<string, Record<string, unknown> | undefined>): string | null {
  const candidates = [
    objects["license"]?.["id"],
    objects["subscription"]?.["license_id"],
    objects["payment"]?.["license_id"],
  ];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const text = String(candidate).trim();
    if (text !== "") return text;
  }
  return null;
}

/**
 * The id this event will be remembered by.
 *
 * Freemius sends one, but not on every shape, and an event with no id would
 * otherwise be exempt from the duplicate rule — which is the one case where
 * being exempt matters, since a redelivery is exactly what the rule is for. So
 * an event without an id gets a digest of its own bytes: a byte-identical
 * redelivery collides, and two genuinely different events do not.
 */
export function eventIdFor(payload: Record<string, unknown>, rawBody: Buffer | string, sha256: (input: Buffer | string) => string): string {
  const direct = payload["id"] ?? (payload["data"] as Record<string, unknown> | undefined)?.["id"];
  if (direct != null && String(direct).trim() !== "") return `fs_${String(direct).trim()}`;
  return `sha_${sha256(rawBody).slice(0, 40)}`;
}

/**
 * When Freemius says this happened.
 *
 * Read from several places because the shapes differ per event type, and
 * returning null rather than `new Date()` when nothing is found — a fabricated
 * timestamp would make an unordered event look ordered, which is worse than
 * admitting we cannot order it.
 */
export function eventTimeFrom(objects: Record<string, Record<string, unknown> | undefined>, payload: Record<string, unknown>): Date | null {
  const candidates = [
    payload["created"],
    (payload["data"] as Record<string, unknown> | undefined)?.["created"],
    objects["license"]?.["updated"],
    objects["license"]?.["created"],
    objects["subscription"]?.["updated"],
    objects["payment"]?.["created"],
  ];
  for (const candidate of candidates) {
    if (candidate == null || candidate === "") continue;
    // Freemius sends "2026-08-15 14:02:11" — no zone, and UTC by their
    // documentation. `new Date` on that string is parsed as *local* time by
    // Node, which on a machine set to anything but UTC shifts every comparison
    // by the offset. Naming the zone removes the guess.
    const text = String(candidate);
    const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(" ", "T")}Z` : text;
    const ms = new Date(normalised).getTime();
    if (Number.isFinite(ms)) return new Date(ms);
  }
  return null;
}
