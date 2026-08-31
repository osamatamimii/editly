/**
 * How many rows a list endpoint sends at once.
 *
 * These live here, shared, for one reason: a cap is only honest if the screen
 * showing the list knows what it is. A limit written as a literal in a route
 * is invisible to the page, so the page cannot tell "this is everything you
 * have" apart from "this is where I stopped" — and the two look identical to
 * whoever is reading it.
 *
 * Where an endpoint can afford to count, it sends a `total` and the page needs
 * no constant. Where it cannot — a bare array, a shape other clients already
 * depend on — the page compares against the cap itself, and these numbers have
 * to be the same number in both places or the notice appears at the wrong time.
 *
 * No zod here on purpose, so the browser can import it without pulling a
 * validation library into the bundle for two integers.
 */

/** The clips library: every tile signs a URL and draws a video element. */
export const CLIPS_LIBRARY_LIMIT = 200;

/** The clips of one project, shown grouped by the run that made them. */
export const PROJECT_CLIPS_LIMIT = 60;

/** What is scheduled, and what happened to what has gone. */
export const SCHEDULED_POSTS_LIMIT = 200;
