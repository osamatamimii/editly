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
