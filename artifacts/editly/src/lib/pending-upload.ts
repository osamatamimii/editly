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
