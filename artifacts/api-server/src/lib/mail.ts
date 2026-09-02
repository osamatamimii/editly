/**
 * The product's mail, which now lives in `lib/mail`.
 *
 * It moved the day the fourth letter turned out to be "your edit is ready":
 * only the worker knows a render finished, and the worker is a separate
 * deployment that must not import this one's modules. The argument for the move
 * rather than a second copy is written at the top of the package — the short
 * version is that `mail_sends` is worth exactly as much as the guarantee that
 * one place decides whether a message has already gone.
 *
 * This file is what keeps every existing caller, and `tools/mail-test.mjs`,
 * pointing at the same names as before. It also binds the API server's own
 * logger to the package, which is silent until somebody does.
 */
import { logMailWith } from "@workspace/mail";
import { logger } from "./logger";

logMailWith(logger);

export * from "@workspace/mail";
