/**
 * "This comes before that", written so it cannot pass when either is missing.
 *
 * Six suites had the same line in different files:
 *
 *     check("and below requireAuth", source.indexOf(a) < source.indexOf(b));
 *
 * `String.indexOf` answers `-1` for something that is not there, and `-1` is
 * less than every real position. So every one of those checks passed *most
 * loudly* in the case it was written to catch — the thing being ordered having
 * been deleted altogether.
 *
 * The list of what they were guarding is the argument for this file:
 *
 *   - the upload-signing route being mounted below `requireAuth`, where the
 *     absent case is a route that mints signed storage URLs for anybody
 *   - the paid plan being written before the customer is told it changed, where
 *     the absent case is a letter saying "your plan changed" and no plan
 *   - the failure branch on the dashboard coming before the empty one, which is
 *     the 12 August regression that section exists for
 *   - a render failure being reported only once it is final, where the absent
 *     case is three apology emails for one render
 *
 * Each of those is green today under the old spelling. None of them is under
 * this one.
 *
 * `deploy-test` asserts that no suite goes back to comparing two `indexOf`
 * results inside a `check`, so the shape cannot return.
 */

/**
 * Whether `first` appears before `second`, and both appear at all.
 *
 * Returns a verdict rather than a boolean so a failing check can say *which*
 * half is wrong: "it is in the wrong order" and "it is not there" send somebody
 * to different places.
 */
export function order(haystack, first, second) {
  const at = haystack.indexOf(first);
  const then = haystack.indexOf(second);
  if (at < 0 && then < 0) return { ok: false, why: `neither ${JSON.stringify(first)} nor ${JSON.stringify(second)} is there` };
  if (at < 0) return { ok: false, why: `${JSON.stringify(first)} is not there at all` };
  if (then < 0) return { ok: false, why: `${JSON.stringify(second)} is not there at all` };
  if (at >= then) return { ok: false, why: `${JSON.stringify(second)} comes first` };
  return { ok: true, why: "" };
}
