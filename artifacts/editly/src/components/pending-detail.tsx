/**
 * A detail that is not known yet, shown as not known rather than as a bracket.
 *
 * The privacy page and the terms are complete about the thing that matters —
 * what happens to somebody's files and who receives them — and incomplete
 * about company registration details only Osama can supply. Three ways to
 * handle that, and two of them are worse:
 *
 * **Ship `[[LEGAL_NAME]]`.** A reader who sees a bracket learns that nobody
 * ever read the document, and stops trusting the parts that *are* true. It is
 * the single strongest signal a policy is boilerplate.
 *
 * **Wait until the details arrive.** Then the substance — the eleven companies,
 * what each receives, the licence we take in somebody's video — sits unread,
 * and every platform review stays blocked on a postal address.
 *
 * **Say it is missing.** Which is what this does. The page goes up, the useful
 * half is readable today, and the gap is a gap somebody can see rather than a
 * typo they have to interpret.
 *
 * `tools/privacy-test.mjs` asserts no raw placeholder ever reaches the page and
 * that a notice appears at the top while any remain, so this cannot quietly
 * become the permanent state.
 */
export function PendingDetail({ what }: { what: string }) {
  return (
    <span
      className="inline-flex items-center rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[0.85em] text-warning"
      data-testid={`pending-${what.toLowerCase().replace(/[^a-z]+/g, "-")}`}
    >
      {what}: being finalised
    </span>
  );
}

/** The line at the top of a page that still has one of these on it. */
export function PendingNotice() {
  return (
    <p
      className="rounded-xl border border-warning/30 bg-warning/[0.07] px-4 py-3 text-sm text-muted-foreground leading-relaxed"
      data-testid="pending-notice"
    >
      Everything on this page about your files, and about who receives what, is
      complete and accurate today. The company registration details at the
      bottom are still being finalised and are marked where they belong.
    </p>
  );
}
