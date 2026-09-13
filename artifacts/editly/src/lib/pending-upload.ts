/**
 * A file picked on one page, uploaded on the next.
 *
 * The dashboard lets someone start a project from a video: the project row is
 * created there, but the bytes belong to the editor, which owns the upload
 * pipeline (progress, poster capture, dimension probing, the lot). A `File`
 * cannot ride a URL through navigation, so it rides memory instead.
 *
 * Deliberately not sessionStorage: a File is a handle to bytes on disk, not
 * bytes, and serialising a 40MB clip to base64 to survive a refresh would cost
 * more than the feature is worth. If the person refreshes between the two
 * pages, the handoff is simply gone and the editor shows its normal upload
 * card — the same screen they would have seen anyway, one click behind where
 * they were.
 */
const pending = new Map<string, File>();

export function stashPendingUpload(projectId: string, file: File): void {
  pending.set(projectId, file);
}

/**
 * Claim and remove. Removal is the double-run guard: React can mount an effect
 * twice, and the second call finding nothing is what stops a second upload.
 */
export function takePendingUpload(projectId: string): File | null {
  const file = pending.get(projectId) ?? null;
  pending.delete(projectId);
  return file;
}

/**
 * The sentence chosen on the first-run screen, typed into the editor.
 *
 * Same idea as the file above and the same lifetime, so it lives beside it
 * rather than in a module of its own. It is **placed in the box, not sent**:
 * the whole point of the first-run screen is that somebody sees what a request
 * to this product looks like, and a sentence that fires on arrival is a
 * sentence they never read.
 */
const pendingMessages = new Map<string, string>();

export function stashPendingMessage(projectId: string, sentence: string): void {
  pendingMessages.set(projectId, sentence);
}

/** Claim and remove, so a re-mount cannot refill a box somebody just cleared. */
export function takePendingMessage(projectId: string): string | null {
  const sentence = pendingMessages.get(projectId) ?? null;
  pendingMessages.delete(projectId);
  return sentence;
}

/**
 * The file somebody picked on the landing page, before they had an account.
 *
 * The two stashes above are keyed by project, because by the time they are
 * written the project exists. This one cannot be: it is filled by a stranger
 * on the front page, and the project is not made until they have signed up and
 * reached the first-run screen. So it is a single slot — there is only ever
 * one person in one tab picking one file — claimed by whatever gets there
 * first.
 *
 * **It survives the sign-up because sign-up does not leave the page.** Email
 * and password with confirmation off returns a session in place, and every
 * route here is client-side, so the module is never re-evaluated and the
 * `File` handle stays valid the whole way from the front page to the editor.
 *
 * And when it does not survive — a hard reload, or the day a provider redirect
 * is switched on — nothing is broken and nothing is lost except a click: the
 * sentence travels in the URL, which survives everything, and the first-run
 * screen asks for the file it always asked for, with the request already
 * written in the box. The degradation is the product's own normal path.
 */
let landingFile: File | null = null;

export function stashLandingFile(file: File | null): void {
  landingFile = file;
}

/** Claim and clear, for the same reason the two above do. */
export function takeLandingFile(): File | null {
  const file = landingFile;
  landingFile = null;
  return file;
}

/**
 * "My Viral Short", not "my-viral-short_v2_FINAL.mp4".
 *
 * The name is a courtesy, not a commitment — the person can rename the project
 * later. What matters is that the dialog never has to ask for a title when the
 * file already carries a perfectly good one.
 */
export function titleFromFilename(name: string): string {
  const stem = name.replace(/\.[a-z0-9]+$/i, "");
  const spaced = stem.replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim();
  if (!spaced) return "New video";
  return spaced.slice(0, 80);
}
