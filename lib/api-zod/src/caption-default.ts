/**
 * What a caption looks like when nobody said.
 *
 * In a file of its own, with nothing behind it, for the same reason `fonts.ts`
 * is: the renderer needs the value and `index.ts` is the whole schema layer, so
 * a value import from there drags zod into the worker's bundle. Not a size
 * worry in the abstract — bundled together, esbuild renamed identifiers inside
 * `timeline.ts`, which `critic-test` caught by comparing two bundles of the
 * same function and nothing else would have.
 *
 * Every caption field used to carry a zod default, and that was the bug rather
 * than the value of the default being wrong. Once the schema has filled a
 * field, "the person chose bold-white" and "nobody on this path ever mentioned
 * a style" are the same object, and every layer downstream — the panel that
 * wants to style an unstyled plan, the habits that want to apply what somebody
 * always does, the reply that wants to say what it decided — has to guess which
 * one it is looking at. `caption-look.ts` guessed by comparing against the
 * default value and documented the guess; it worked only for as long as no
 * default was reachable by name.
 *
 * So the fields are optional and genuinely absent, and the answer is composed
 * here, once, at the last moment before the cues are built. Absent means
 * nobody said, at every layer, all the way down.
 *
 * The values are Osama's, and they are the reference edit rather than a
 * cautious middle:
 *
 *   - **glow** — measured frame by frame off the reference he sent last: a
 *     plain grotesque at a real bold, ink a shade off white, and a wide cold
 *     halo that arrives with each word and then stays. No stroke, no box and
 *     no shadow — «لا تستخدم ستروك بالمنصة ابدا», «ولا تستخدم الشادو الا
 *     بحالات استثنائية لكن في هذه الحاله لا يحتاج». It also brings `focus`
 *     with it, because a style's own `defaultAnimation` is consulted now that
 *     "pop" is no longer stamped on every plan, and `focus` is the lockup that
 *     reference is built on: the sentence so far, small, under one word at
 *     twice the size.
 *
 *     It replaced **creator**, which was the same lockup read off the two
 *     edits before it and differs in what it is made of: a heavy rounded face,
 *     a mint gradient on the keyword, a real shadow. Still in the catalogue and
 *     still one sentence away — «كرييتور» — because the change here is which
 *     one a person gets without asking, not which ones exist.
 *   - **middle** — where short-form has put captions for three years. The
 *     bottom is where a burnt-in subtitle goes, and a subtitle is not what
 *     this product makes.
 *   - **quick** — one to three words at a time, measured off the fast-cut
 *     reference. With `maxLines: 1` this is the whole rule he gave: «يظهر
 *     بسطر واحد بـ3-4 كلمات».
 *
 * Not a user setting and not stored anywhere: this is what the product does
 * when it is not told otherwise, and anything the person says or picks is
 * present on the operation and wins by being present at all.
 */
export const DEFAULT_CAPTION_LOOK = {
  style: "glow",
  position: "middle",
  size: "m",
  pace: "quick",
} as const;

