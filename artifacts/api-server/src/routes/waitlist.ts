import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db, waitlistTable } from "@workspace/db";
import { JoinWaitlistBody, JoinWaitlistResponse } from "@workspace/api-zod";
import { rateLimitByIp, LIMITS } from "../lib/rate-limit";

/**
 * The waiting list.
 *
 * The only public write in the product. Everything else is behind a bearer
 * token; this one is open to the internet by design, because the whole point is
 * that the person signing up does not have an account yet.
 *
 * That makes three things load-bearing, and they are the only three:
 *
 * **It is rate limited by address**, because open with no limit is an
 * invitation to fill the table.
 *
 * **The address is normalised before it is stored** — trimmed, lowercased —
 * so the primary key can do its job. Normalising on read instead means every
 * reader has to remember to, and the one that forgets makes the duplicate the
 * key was meant to prevent.
 *
 * **Signing up twice is not an error.** Somebody who clicks the button again,
 * or comes back next week having forgotten, gets the same friendly answer as
 * the first time. `ON CONFLICT DO NOTHING` makes the second write a no-op, and
 * the response does not distinguish the cases — not to hide anything, but
 * because "you are already on the list" and "you are on the list" are the same
 * fact to the person reading it.
 */
const router: IRouter = Router();

router.post(
  "/waitlist",
  rateLimitByIp(LIMITS.waitlist),
  async (req, res): Promise<void> => {
    const parsed = JoinWaitlistBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "That does not look like an email address." });
      return;
    }

    const email = parsed.data.email.trim().toLowerCase();
    const source = parsed.data.source?.trim().slice(0, 120) || null;

    await db
      .insert(waitlistTable)
      .values({ email, source })
      .onConflictDoNothing({ target: waitlistTable.email });

    // Read after writing rather than counting before: two people signing up in
    // the same second would otherwise both be told the same position, and a
    // number that is wrong is worse than no number.
    const [row] = await db
      .select({ total: sql<number>`count(*)` })
      .from(waitlistTable);

    res.status(201).json(
      JoinWaitlistResponse.parse({
        joined: true,
        // What they are actually curious about: how many people are ahead of
        // them. Reported as the size of the list rather than their index in it,
        // because their index is not stable — nothing stops us admitting people
        // out of order, and a promised position we then break is a small lie
        // that costs more than the number is worth.
        total: Number(row?.total ?? 0),
      }),
    );
  },
);

export default router;
