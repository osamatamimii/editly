/**
 * Who is allowed to see the console.
 *
 * The obvious design is a boolean column — `subscriptions.is_admin`, or a
 * dedicated `admins` table — and it is the wrong one. Every write path in this
 * codebase is a path that, if it ever has a bug, can set a column. A column
 * that grants administrative access turns any single write vulnerability
 * anywhere into a full privilege escalation, and the blast radius of that is
 * every customer's data at once.
 *
 * So the list lives outside the database entirely: an environment variable,
 * read once at import, that no HTTP request can reach. Changing who is an
 * admin requires access to the deployment's settings — which is to say, to the
 * account that owns the deployment. That is exactly the property we want, and
 * it costs a redeploy, which is exactly how often this should change.
 *
 * The unset case is the one that matters most. A missing variable means
 * **nobody** is an admin — never "everybody", and never "the first user".
 * Defaulting open is the classic form of this bug and it fails silently in the
 * safe-looking direction: staging looks fine, production is wide open.
 */

/**
 * Auth user ids allowed into `/admin/*`, from `ADMIN_USER_IDS`.
 *
 * Comma or whitespace separated. Read at import so the answer cannot change
 * between two requests of the same deployment — an allowlist that can be
 * re-read mid-process is an allowlist somebody can race.
 */
const ALLOWED: ReadonlySet<string> = new Set(
  (process.env["ADMIN_USER_IDS"] ?? "")
    .split(/[\s,]+/)
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id.length > 0),
);

/** How many ids are configured. For the health route; never the ids themselves. */
export function adminCount(): number {
  return ALLOWED.size;
}

export function isAdmin(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return ALLOWED.has(userId.trim().toLowerCase());
}
