/**
 * Writing down the correction, beside the render that carries it.
 *
 * Split from `edit-pairs.ts` on purpose: that file is pure and is where the
 * privacy guarantee lives, so it has no database in it and can be checked
 * without one. This file is the three lines that reach the table, and it is
 * deliberately the only place they are written.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { editPairsTable, jobsTable } from "@workspace/db";
import type { EditPlan } from "@workspace/api-zod";
import { pairFrom, worthKeeping } from "./edit-pairs";

/**
 * The previous plan for this project, and the one replacing it, as a pair.
 *
 * Every way this can decline is a return rather than a throw. It is written
 * inside the transaction that accepts a render, and a customer must never lose
 * a render because a row about how we improve failed to insert — the ordering
 * of the two in `start-render.ts` says which one matters.
 */
export async function recordEditPair(
  tx: unknown,
  input: { userId: string; projectId: string; plan: EditPlan },
): Promise<void> {
  try {
    // The transaction, structurally. Typed by what is used rather than by the
    // driver's own type, so this file does not have to name a database library
    // to write two queries against one.
    const db = tx as {
      select: (columns: Record<string, unknown>) => {
        from: (table: unknown) => {
          where: (clause: unknown) => {
            orderBy: (order: unknown) => { limit: (n: number) => Promise<Array<{ plan?: unknown }>> };
          };
        };
      };
      insert: (table: unknown) => { values: (row: Record<string, unknown>) => Promise<unknown> };
    };

    /*
      The last plan this project rendered, not the last one it was sent.

      A queued or failed job is a plan nobody has seen the result of, so a
      change from it is not a correction of anything — it is a customer editing
      a request they had not yet watched. What teaches is the difference between
      what we delivered and what they asked for instead.
    */
    const [previous] = await db
      .select({ plan: jobsTable.plan })
      .from(jobsTable)
      .where(and(eq(jobsTable.projectId, input.projectId), eq(jobsTable.status, "done")))
      .orderBy(desc(jobsTable.createdAt))
      .limit(1);

    if (!previous?.plan) return;

    const pair = pairFrom(previous.plan as EditPlan, input.plan);
    if (!worthKeeping(pair)) return;

    await db.insert(editPairsTable).values({
      id: randomUUID(),
      userId: input.userId,
      projectId: input.projectId,
      before: pair.before,
      after: pair.after,
      changes: pair.changes,
      structure: pair.structure,
    });
  } catch {
    /*
      Silent, and it is the one place in this repository where that is right.

      This runs inside the transaction that accepts a paid render. A throw here
      rolls that back, so a customer loses a render because a row about how we
      get better could not be written — which inverts what the two are worth. A
      pair that was not recorded costs one row out of millions; a render that
      was not accepted costs the thing they paid for.
    */
  }
}
