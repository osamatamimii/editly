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
/** Which caption faces to draw with. Optional on both shapes; see fonts.ts. */
export interface CaptionFontChoice {
  latin?: string;
  arabic?: string;
}

export type RenderRequest =
  | { plan: EditPlan; fonts?: CaptionFontChoice }
  | { templateId: string; fonts?: CaptionFontChoice };

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

export const getCancelRenderUrl = (projectId: string) => `/api/projects/${projectId}/render/cancel`;

/** What the server answers: the row's status *after* the request. */
export interface CancelledRender {
  id: string;
  status: RenderJob["status"];
  cancelled: true;
}

export async function cancelRender(projectId: string): Promise<CancelledRender> {
  return customFetch<CancelledRender>(getCancelRenderUrl(projectId), { method: "POST" });
}

/**
 * Stop the render that is going.
 *
 * Hand-written beside `useStartRender` for the same reason it is: what happens
 * after the request is part of the contract rather than a caller's choice. In
 * particular the poll has to be woken immediately — a queued render stops the
 * moment this returns, and a running one takes up to one of the worker's lock
 * renewals to notice, so the screen must go on asking rather than deciding for
 * itself that it is over.
 */
export function useCancelRender(): UseMutationResult<CancelledRender, Error, { id: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }) => cancelRender(id),
    onSuccess: (_answer, { id }) => {
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
    /*
      A 404 is an answer, not a fault.

      A project that has never been rendered answers 404 for ever. Retrying it
      is noise on every visit, and this hook is mounted on the editor, which is
      the screen people leave open.
    */
    retry: (count, error) => (isNotFound(error) ? false : count < 2),
    refetchInterval: (query) => {
      /*
        Stop on a failure as well as on a finish.

        This read `query.state.data`, which is the last *successful* answer —
        so on a 401 (an expired session on a tab left open overnight), a 404
        (a project never rendered), or a sustained 5xx, the data stayed
        whatever it last was and this went on asking every five seconds for as
        long as the tab lived. Twelve requests a minute per tab, each one a
        serverless invocation, for an answer that is not coming; and the
        progress bar sat frozen at whatever it had reached, because there is no
        error branch on this screen either. Nothing was reported, by design:
        the query had data, it simply had old data.

        `query.state.status` is the one that knows. The export page solved the
        same shape and this hook did not.
      */
      if (query.state.status === "error") return false;
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 5000 : false;
    },
  });
}

/** A 404 from `customFetch`, which is the "never rendered" answer. */
function isNotFound(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 404 || /\b404\b/.test(String((error as Error | null)?.message ?? ""));
}

export function isRenderInFlight(job: RenderJob | null | undefined): boolean {
  return job?.status === "queued" || job?.status === "running";
}
