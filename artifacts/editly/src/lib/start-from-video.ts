/**
 * Whether this file can become a project, decided in one place.
 *
 * Two screens now start a project from a video: the dashboard, and the
 * clip-extraction section where somebody drops an episode to get posts out of
 * it. Both have to refuse the same files for the same reasons, and both have to
 * refuse them *before* the project row exists — a rejected file should cost a
 * toast, not an empty project named after a spreadsheet.
 *
 * The rule lives here and the wording does not. Each screen says no in its own
 * words, because the sentence a person reads on the dashboard and the sentence
 * they read while holding a two-hour episode are not the same sentence. What
 * must not differ is which files get through.
 */

/** Why a file was refused. Null means it was not. */
export type VideoRejection = "type" | "size" | null;

/**
 * The extension check exists beside the MIME check because browsers disagree
 * about `.mov`: some report `video/quicktime`, some report nothing at all, and
 * a file with an empty `type` is a normal thing to be handed rather than a
 * suspicious one.
 */
export function videoRejection(
  file: { type?: string; name: string; size: number },
  { accepted, ceilingBytes }: { accepted: readonly string[]; ceilingBytes: number },
): VideoRejection {
  const type = file.type ?? "";
  if (!accepted.includes(type) && !/\.(mp4|mov|webm)$/i.test(file.name)) return "type";
  // Zero is not a ceiling, it is a ceiling that has not loaded yet — the
  // subscription query answers late on a cold screen, and refusing every file
  // for a second is worse than letting Storage refuse the one that is really
  // too big.
  if (ceilingBytes > 0 && file.size > ceilingBytes) return "size";
  return null;
}
