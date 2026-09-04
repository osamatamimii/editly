export function serializeProject(project: Record<string, unknown>) {
  return {
    ...project,
    createdAt: project.createdAt instanceof Date ? project.createdAt.toISOString() : project.createdAt,
    updatedAt: project.updatedAt instanceof Date ? project.updatedAt.toISOString() : project.updatedAt,
  };
}

export function serializeMessage(message: Record<string, unknown>) {
  return {
    ...message,
    createdAt: message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt,
  };
}

export function serializeExport(exportJob: Record<string, unknown>) {
  return {
    ...exportJob,
    createdAt: exportJob.createdAt instanceof Date ? exportJob.createdAt.toISOString() : exportJob.createdAt,
    updatedAt: exportJob.updatedAt instanceof Date ? exportJob.updatedAt.toISOString() : exportJob.updatedAt,
  };
}

export function serializeJob(job: Record<string, unknown>) {
  return {
    id: job.id,
    projectId: job.projectId,
    status: job.status,
    progress: job.progress,
    stage: job.stage ?? null,
    error: job.error ?? null,
    plan: job.plan,
    outputPath: job.outputPath ?? null,
    // What the render did and could not do. Reaching the client is the whole
    // point of having written them; they used to stop at a log line.
    notes: Array.isArray(job.notes) ? job.notes : [],
    /*
      Only when it is true, so an ordinary render's shape does not change.

      A stopped render is `failed` — see the migration for why it is not a
      fourth status — which leaves the screen unable to tell a decision from a
      fault. This is the flag that lets it, and it is the difference between
      "You stopped this render" and an apology for a failure that never
      happened.
    */
    ...(job.cancelledAt ? { cancelled: true as const } : {}),
    /*
      Absent unless somebody is actually waiting. `null` is a real answer here —
      "queued, and we cannot honestly say how long" — and it is a different
      answer from the field not being there at all, which is what a running or
      finished job gets.
    */
    ...(typeof job.waitSeconds === "number" || job.waitSeconds === null
      ? { waitSeconds: job.waitSeconds as number | null }
      : {}),
    createdAt: job.createdAt instanceof Date ? job.createdAt.toISOString() : job.createdAt,
    updatedAt: job.updatedAt instanceof Date ? job.updatedAt.toISOString() : job.updatedAt,
  };
}
