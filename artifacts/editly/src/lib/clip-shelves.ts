/**
 * The two decisions the clip-extraction screen makes before it draws anything.
 *
 * Both used to be inline in the page, which meant the only way to check either
 * was to open a browser and look — and the browser suite renders that screen
 * from a fixture, so the questions "is a nine-minute recording offered" and
 * "does a recording with two clips get one shelf or two" had no answer anywhere
 * that a build could read. They are arithmetic on a list. They belong in a
 * module a suite can call.
 */

/** One clip, as much of it as the filing needs to know. */
export interface ShelvableClip {
  id: string;
  projectId: string;
  projectTitle: string;
  startSeconds: number;
}

export interface Shelf<T extends ShelvableClip> {
  projectId: string;
  title: string;
  clips: T[];
}

/**
 * Below eight minutes there is nothing to extract from: the file is already
 * the length of a post. The same line the dashboard draws between an episode
 * and a hook, and drawn from the recording's own measured length rather than
 * from a label somebody has to remember to set.
 */
export const CLIPPABLE_SECONDS = 8 * 60;

/** How many recordings the section offers at once. A row, not a directory. */
export const MOST_OFFERED = 6;

/**
 * One shelf per recording, in the order the recordings first appear in the
 * list — which, since the library arrives newest first, is most recent first.
 *
 * Built from the clips rather than from the project list on purpose. The
 * library is capped, and a recording whose clips all fell outside the cap has
 * no shelf here, which is correct: a shelf built from projects would have drawn
 * that recording with nothing under it and said, in the only way a screen can,
 * that it produced nothing.
 */
export function shelvesFrom<T extends ShelvableClip>(clips: readonly T[]): Shelf<T>[] {
  const byProject = new Map<string, Shelf<T>>();
  for (const clip of clips) {
    const shelf = byProject.get(clip.projectId) ?? {
      projectId: clip.projectId,
      title: clip.projectTitle,
      clips: [] as T[],
    };
    shelf.clips.push(clip);
    byProject.set(clip.projectId, shelf);
  }
  /*
    Inside a shelf, source order.

    The library as a whole is newest first, which is right for "what have I got
    to post". Within one recording it is wrong: somebody reviewing what came out
    of an episode is reading it against the episode, and clip 2 should follow
    clip 1 the way it does in the take.
  */
  for (const shelf of byProject.values()) {
    shelf.clips.sort((a, b) => a.startSeconds - b.startSeconds);
  }
  return [...byProject.values()];
}

export interface OfferableRecording {
  id: string;
  duration?: number | null;
  videoPath?: string | null;
}

/**
 * The recordings this section can actually take clips out of.
 *
 * Longest first, because somebody standing here with a two-hour episode and a
 * nine-minute one almost always means the episode. A project with no file yet
 * is excluded: offering to cut from a recording that has not finished uploading
 * sends somebody to an editor that can only tell them to wait.
 */
export function clippableRecordings<T extends OfferableRecording>(
  projects: readonly T[] | undefined,
  { seconds = CLIPPABLE_SECONDS, most = MOST_OFFERED }: { seconds?: number; most?: number } = {},
): T[] {
  return (projects ?? [])
    .filter((project) => (project.duration ?? 0) >= seconds && Boolean(project.videoPath))
    .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
    .slice(0, most);
}
