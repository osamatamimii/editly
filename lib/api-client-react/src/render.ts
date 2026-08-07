/**
 * Render queue hooks.
 *
 * Hand-written rather than generated: rendering is asynchronous in a way the
 * rest of the API is not — the mutation returns a job, and the truth arrives by
 * polling — and the polling behaviour is part of the contract, not an incidental
 * caller choice. Keeping it here means every screen polls the same way.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";
import type { EditPlan, RenderJob, TemplateSummary } from "./generated/api.schemas";

export const getStartRenderUrl = (projectId: string) => `/api/projects/${projectId}/render`;
export const getRenderStatusUrl = (projectId: string) => `/api/projects/${projectId}/render/status`;

export const getRenderStatusQueryKey = (projectId: string) =>
  [`/api/projects/${projectId}/render/status`] as const;

/** Either a plan built here, or the id of one saved on the server. */
export type RenderRequest = { plan: EditPlan } | { templateId: string };

export async function startRender(projectId: string, request: RenderRequest): Promise<RenderJob> {
  return customFetch<RenderJob>(getStartRenderUrl(projectId), {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export async function listTemplates(options?: RequestInit): Promise<TemplateSummary[]> {
  return customFetch<TemplateSummary[]>("/api/templates", { ...options, method: "GET" });
}

/** The named looks. They never change within a session, so they never refetch. */
export function useTemplates(): UseQueryResult<TemplateSummary[], Error> {
  return useQuery({
    queryKey: ["/api/templates"],
    queryFn: ({ signal }) => listTemplates({ signal }),
    staleTime: Infinity,
  });
}

export async function getRenderStatus(projectId: string, options?: RequestInit): Promise<RenderJob | null> {
  return customFetch<RenderJob | null>(getRenderStatusUrl(projectId), { ...options, method: "GET" });
}

export function useStartRender(): UseMutationResult<
  RenderJob,
  Error,
  { id: string } & RenderRequest
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...request }) => startRender(id, request as RenderRequest),
    onSuccess: (_job, { id }) => {
      // The job exists now; start polling immediately rather than after the
      // next interval, so the UI does not sit on a stale "not rendering".
      void queryClient.invalidateQueries({ queryKey: getRenderStatusQueryKey(id) });
    },
  });
}

/**
 * Polls while a render is in flight and stops once it settles.
 *
 * Five seconds rather than one: a render takes minutes, the worker only writes
 * progress between ffmpeg steps, and every poll is a serverless invocation.
 */
export function useRenderStatus(
  projectId: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<RenderJob | null, Error> {
  return useQuery({
    queryKey: getRenderStatusQueryKey(projectId),
    queryFn: ({ signal }) => getRenderStatus(projectId, { signal }),
    enabled: (options.enabled ?? true) && !!projectId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 5000 : false;
    },
  });
}

export function isRenderInFlight(job: RenderJob | null | undefined): boolean {
  return job?.status === "queued" || job?.status === "running";
}
