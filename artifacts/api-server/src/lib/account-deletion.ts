/**
 * What "delete my account" has to mean.
 *
 * The route that calls this is four lines of adapter; everything that could be
 * wrong is here, and it is here rather than there so it can be tested without a
 * database — because the properties worth protecting are about *order* and
 * *refusal*, and neither is visible in a passing integration test.
 *
 * Three rules, in the order they matter.
 *
 * **A deletion is never partial and reported as complete.** If the credentials
 * that reclaim storage are missing, nothing is touched at all. A half-delete
 * leaves the person able to sign in, so they believe they are gone and are not,
 * and leaves their video in a bucket, which is the part they actually cared
 * about. A refusal can be acted on; a false confirmation cannot.
 *
 * **The bytes go first.** The rows are what name the objects. Delete them first
 * and the storage becomes unreachable garbage that only a manual sweep will
 * ever find — the person's video, still on our disks, with nothing left
 * pointing at it.
 *
 * **The login goes last.** An account with no rows can be deleted again by the
 * person themselves. Rows with no account can only be cleaned up by us.
 */

export interface DeletionSteps {
  /** True when the service role credentials needed to reclaim storage exist. */
  storageConfigured: boolean;
  /** Project ids owned by this user. */
  listProjects: () => Promise<string[]>;
  /**
   * Remove every stored object for one project. Returns false when it could
   * not be done.
   *
   * This used to be `Promise<void>` and described as best effort — which
   * quietly suspended rule one for the step rule one is about. A Storage
   * outage during the loop below removed nothing, said nothing, and the rows
   * that name those objects were deleted immediately afterwards, so the
   * person's videos stayed on our disks with nothing left pointing at them and
   * the response said "deleted".
   */
  removeObjects: (projectId: string) => Promise<boolean>;
  /** Remove every database row this user owns. */
  removeRows: () => Promise<void>;
  /** Remove the login. Returns false when it could not be done. */
  removeLogin: () => Promise<boolean>;
}

export type DeletionResult =
  | {
      deleted: false;
      status: 503;
      error: string;
    }
  | {
      deleted: true;
      projects: number;
      loginRemoved: boolean;
      note?: string;
    };

export const STORAGE_FAILED_MESSAGE =
  "We couldn't remove your videos from storage just now, so nothing has been deleted — we won't tell you your account is gone while your files are still here. Please try again shortly.";

export const NOT_CONFIGURED_MESSAGE =
  "We can't delete accounts right now — the storage credentials this needs aren't configured, and we won't tell you your videos are gone while they're still here. Please try again shortly.";

/**
 * The login survived but the data did not. Worth saying out loud: the person
 * asked to disappear, most of them has, and the remaining part is an email
 * address we will clear by hand.
 */
export const LOGIN_SURVIVED_NOTE =
  "Your videos and projects are gone. The login itself could not be removed automatically and will be cleared manually — you will not be charged, and nothing of yours remains in the product.";

export async function deleteAccount(steps: DeletionSteps): Promise<DeletionResult> {
  if (!steps.storageConfigured) {
    return { deleted: false, status: 503, error: NOT_CONFIGURED_MESSAGE };
  }

  const projects = await steps.listProjects();

  // Bytes before rows. See the note at the top of this file: reversing these
  // two turns a deletion into an orphaning.
  for (const projectId of projects) {
    const removed = await steps.removeObjects(projectId);
    // Stop at the first one that would not go. Carrying on and deleting the
    // rows anyway is the half-delete this whole module exists to refuse, and
    // the fact that some projects were removed first does not make it less of
    // one — it makes the account harder to finish deleting later.
    if (!removed) return { deleted: false, status: 503, error: STORAGE_FAILED_MESSAGE };
  }

  await steps.removeRows();

  const loginRemoved = await steps.removeLogin();

  return {
    deleted: true,
    projects: projects.length,
    loginRemoved,
    ...(loginRemoved ? {} : { note: LOGIN_SURVIVED_NOTE }),
  };
}
