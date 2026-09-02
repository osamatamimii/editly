/**
 * What the server just refused, said once instead of three times.
 *
 * Three places in the editor start work the plan can refuse: attaching a
 * reference video, applying a template, and the main "generate" button. All
 * three got their own copy of the same `catch`, and the copies drifted, which
 * is the only thing three copies of anything ever do.
 *
 * Where they had drifted to was the worst possible arrangement. The two side
 * paths knew that 402, 413 and 429 are the plan speaking and put a "See plans"
 * button on the toast. The main button, the large one in the middle of the
 * screen that most people press, knew only 409. So the server would answer
 * "you have 3 minutes left this month and this edit needs 11", and the editor
 * would print **"Could not start the render"** above it, with no way up and a
 * title suggesting a fault at our end.
 *
 * Nothing failed. The API answered correctly, the sentence it wrote was shown,
 * and the person read a paywall dressed as an outage and left.
 *
 * ## Why the titles are here and not on the server
 *
 * The *sentence* is the server's: it knows the minutes, the plan and the
 * length, and it is already translated. The *title* is a category, and the
 * category is what decides whether a button appears beside it. Keeping the two
 * apart means a new limit needs one line here and nothing on the screen has to
 * be rewritten.
 */
import { ToastAction } from "@/components/ui/toast";
import type { ToastActionElement } from "@/components/ui/toast";

/**
 * The statuses that mean "your plan", not "our fault".
 *
 * 402 the feature is not on this plan, 413 the file is longer than the plan
 * allows, 429 the minutes for the month are spent. Each one has a way up, and
 * each one is a sentence the server has already written.
 */
export const PLAN_WALL = [402, 413, 429] as const;

export function isPlanWall(status: number | undefined): boolean {
  return PLAN_WALL.includes(status as (typeof PLAN_WALL)[number]);
}

/** The sentence the API wrote, if it wrote one. */
export function saidBy(error: unknown): string | undefined {
  const data = (error as { data?: { error?: string } })?.data?.error;
  if (data) return data;
  return error instanceof Error ? error.message : undefined;
}

const TITLES: Record<number, string> = {
  402: "That's a paid feature",
  409: "Already rendering",
  413: "That file is too long for this plan",
  429: "Not enough minutes left",
};

export interface Refusal {
  title: string;
  description?: string;
  variant: "destructive";
  action?: ToastActionElement;
}

/**
 * One refusal, ready to hand to `toast`.
 *
 * `whenNothingElse` is the title for a status nobody has a category for, and
 * it is the caller's because "Could not attach that reference" and "Could not
 * start the render" are different things to have failed.
 */
export function refusalToast(error: unknown, whenNothingElse: string): Refusal {
  const status = (error as { status?: number })?.status;

  const refusal: Refusal = {
    title: TITLES[status ?? 0] ?? whenNothingElse,
    description:
      status === 409 ? "This project has a render in progress." : saidBy(error),
    variant: "destructive",
  };

  if (isPlanWall(status)) {
    refusal.action = (
      <ToastAction altText="See plans" onClick={() => { window.location.href = "/#pricing"; }}>
        See plans
      </ToastAction>
    );
  }

  return refusal;
}
