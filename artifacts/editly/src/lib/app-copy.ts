/**
 * Every sentence the product says, in both languages.
 *
 * The landing page has been bilingual since `landing-copy.ts` was written. The
 * product behind it was not: about four hundred and fifty sentences, from the
 * sign-in screen to the render plan to the refusals, existed in English only.
 * `lib/language.tsx` says exactly what that cost and why the honest answer at
 * the time was to declare English on those screens rather than lay Arabic
 * attributes over English words. This file is the other half of that decision
 * finally being paid for: the screens are written in both languages now, so the
 * document can stop apologising for them.
 *
 * ## Pairs on one line, one file per screen
 *
 * The pairing is the argument `landing-copy.ts` makes, and it is the whole
 * reason that file has not drifted. Two copies of a sentence drift, and the
 * half that drifts is always the half fewer people read. Here the two
 * languages sit on the same line, so a sentence changed in one and not the
 * other is visible in the diff rather than discoverable by a customer.
 *
 * The sentences themselves live in `lib/copy/`, a file per screen, and this
 * module is the door: the rules are here, the words are there. That split is a
 * bundling decision. A module is one unit to a bundler, so while every group
 * sat in one file, `not-found.tsx` and the crash screen — both in the first
 * chunk the landing page downloads — pulled the editor's and the console's
 * sentences in with them. Measured: 17kB of gzip, against the 200kB budget
 * `tools/speed-test.mjs` holds. It is still one place to change a sentence and
 * one place to read the rules.
 *
 * ## The Arabic is written, not translated
 *
 * This product's first audience reads Arabic, and translated software reads as
 * translated in one line. So these are Arabic sentences that do the same job,
 * not the English put through a dictionary. Where a phrase has no natural
 * Arabic form it says something else that is true rather than something
 * awkward that is faithful. Where English has a word Arabic does not use for
 * this — "dashboard", "render", "export" — the Arabic says what the thing is.
 *
 * Product names stay in Latin script, exactly as on the landing page: TikTok,
 * Reels, Shorts, YouTube, Instagram, Facebook, Snapchat, X, LUFS, Editly and
 * Noah are what they are called in Arabic too, and transliterating a platform's
 * name is how you look like you have not used it.
 *
 * ## What is deliberately not here
 *
 * The legal pages. `/privacy` and `/terms` are the two screens in this product
 * whose words are a commitment rather than a description, and an Arabic
 * privacy policy written by whoever was translating the buttons is a liability
 * with a language toggle on it. They need a lawyer, not a copy table, and they
 * keep declaring English until they have one.
 *
 * The caption faces' own notes. `lib/api-zod/src/fonts.ts` describes each face
 * in the script that face sets: the Latin ones in English, the Arabic ones in
 * Arabic. That is not an oversight left here. The note is read *while looking
 * at the sample*, and a description of how a face sets Arabic, written in a
 * face that cannot draw Arabic, is a sentence that argues with the picture
 * beside it.
 *
 * The operations console's *data*. `/admin` is translated because it is part of
 * the product and somebody reads it at two in the morning, but a job state, a
 * queue name and a Postgres error stay in the words the systems that produce
 * them use. Translating `stalled` into Arabic in one place and leaving it in
 * English in the log is how a person searching for the thing they just read
 * finds nothing.
 *
 * ## Numbers
 *
 * Western digits in both languages, everywhere. Arabic-Indic digits look right
 * in a paragraph of Arabic prose and wrong beside a price, a duration or a
 * resolution, and this product is mostly the second kind of number. The
 * landing page settled this already; this file follows it rather than
 * relitigating it per screen.
 */
import type { Phrase, Template } from "@/lib/landing-copy";

export type { Phrase, Template };

import { COMMON, LOAD, REFUSAL } from "@/lib/copy/common";
import { THEME, LANGUAGE, CRASH, NOT_FOUND } from "@/lib/copy/chrome";
import { TRANSFER, CHECKOUT } from "@/lib/copy/transfer";
import { LOGIN, RESET } from "@/lib/copy/login";
import { ACCOUNT } from "@/lib/copy/account";
import { DASHBOARD } from "@/lib/copy/dashboard";
import { EDITOR, MARKS, FONTS, VOICE, LIBRARY, STOCK, PROJECT_CLIPS } from "@/lib/copy/editor";
import { EXPORT } from "@/lib/copy/export";
import { CLIPS } from "@/lib/copy/clips";
import { SCHEDULED, POSTS, CONNECTIONS, COMPOSER } from "@/lib/copy/scheduled";
import { ADMIN } from "@/lib/copy/admin";

export { COMMON, LOAD, REFUSAL } from "@/lib/copy/common";
export { THEME, LANGUAGE, CRASH, NOT_FOUND } from "@/lib/copy/chrome";
export { TRANSFER, CHECKOUT } from "@/lib/copy/transfer";
export { LOGIN, RESET } from "@/lib/copy/login";
export { ACCOUNT } from "@/lib/copy/account";
export { DASHBOARD } from "@/lib/copy/dashboard";
export { EDITOR, MARKS, FONTS, VOICE, LIBRARY, STOCK, PROJECT_CLIPS } from "@/lib/copy/editor";
export { EXPORT } from "@/lib/copy/export";
export { CLIPS } from "@/lib/copy/clips";
export { SCHEDULED, POSTS, CONNECTIONS, COMPOSER } from "@/lib/copy/scheduled";
export { ADMIN } from "@/lib/copy/admin";

/**
 * The whole table, for the checks that read it as a tree.
 *
 * Nothing in the app imports this, and nothing should: importing it is
 * importing every sentence in the product, which is exactly what splitting the
 * groups into `lib/copy/` was for. `tools/language-test.mjs` walks it.
 */
export const APP = {
  common: COMMON,
  load: LOAD,
  refusal: REFUSAL,
  login: LOGIN,
  theme: THEME,
  language: LANGUAGE,
  account: ACCOUNT,
  dashboard: DASHBOARD,
  export: EXPORT,
  clips: CLIPS,
  scheduled: SCHEDULED,
  posts: POSTS,
  connections: CONNECTIONS,
  composer: COMPOSER,
  library: LIBRARY,
  stock: STOCK,
  projectClips: PROJECT_CLIPS,
  marks: MARKS,
  crash: CRASH,
  fonts: FONTS,
  reset: RESET,
  checkout: CHECKOUT,
  transfer: TRANSFER,
  editor: EDITOR,
  voice: VOICE,
  admin: ADMIN,
  notFound: NOT_FOUND,
} as const;
