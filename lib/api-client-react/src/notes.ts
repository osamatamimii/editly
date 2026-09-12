/**
 * The transcript, and the notes pinned to moments of it.
 *
 * Hand-written beside `render.ts` for the same reason it is: how these are
 * fetched is part of the contract rather than a caller's choice. A transcript
 * does not exist until the project has been heard, so the hook keeps asking
 * while `available` is false and stops for good the moment it turns true —
 * words on the source clock never change after that, and refetching twenty
 *-seven thousand of them on every window focus would be all cost and no
 * information. Notes are ordinary list-and-mutate, but every mutation
 * invalidates the one list so a chip never outlives its row.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

/** `[startMs, endMs, text]` — the wire shape, documented in the spec. */
export type TranscriptWord = [number, number, string];

export interface Transcript {
  available: boolean;
  language: string | null;
  words: TranscriptWord[];
  truncated: boolean;
}

/**
 * What the door answers when the panel asks to have the video read.
 *
 * Every one of these is a 200, because none of them is a failure — the words
 * are already here, somebody is already reading it, there is nothing to read
 * from, or this free account has had its three for today.
 */
export interface ListenRequest {
  status: "ready" | "queued" | "working" | "no-source" | "enough-for-today";
  limit?: number;
}

export interface ProjectNote {
  id: string;
  sourceMs: number;
  text: string;
  createdAt: string;
}

export interface ProjectNotes {
  notes: ProjectNote[];
  limit: number;
}

export const getTranscriptUrl = (projectId: string) => `/api/projects/${projectId}/transcript`;
export const getNotesUrl = (projectId: string) => `/api/projects/${projectId}/notes`;

export const getTranscriptQueryKey = (projectId: string) =>
  [`/api/projects/${projectId}/transcript`] as const;
export const getNotesQueryKey = (projectId: string) => [`/api/projects/${projectId}/notes`] as const;

export function useTranscript(
  projectId: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<Transcript, Error> {
  return useQuery({
    queryKey: getTranscriptQueryKey(projectId),
    queryFn: ({ signal }) => customFetch<Transcript>(getTranscriptUrl(projectId), { signal, method: "GET" }),
    enabled: (options.enabled ?? true) && !!projectId,
    /*
      While the project has not been heard yet, ask again on a slow clock:
      transcription follows the upload by a minute or three and nothing tells
      the browser when it lands. Once the words exist they are final — they
      are on the source clock, and the source does not change — so the answer
      is kept for the life of the page. On an error, stop; the panel shows
      its waiting state and the person can reopen it.
    */
    refetchInterval: (query) => {
      if (query.state.status === "error") return false;
      return query.state.data?.available ? false : 15000;
    },
    staleTime: Infinity,
  });
}

/**
 * Ask for the words, which is what opening the panel means.
 *
 * The panel's own sentence has always said the transcription follows the
 * upload on its own — and nothing was making that true, because the words were
 * only ever written as a side effect of a render that needed them. So a video
 * nobody had captioned had none, and the panel waited in front of a promise.
 *
 * Asking on open rather than on upload is the difference between paying for
 * every file somebody sends us and paying for the ones somebody sits down to
 * read. The store keys the words to the source, so the render that follows
 * does not buy them again: this moves the cost earlier, it does not add one.
 */
export function useAskForTranscript(projectId: string): UseMutationResult<ListenRequest, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => customFetch<ListenRequest>(getTranscriptUrl(projectId), { method: "POST" }),
    onSuccess: (answer) => {
      // "ready" means somebody else's render bought them while this page was
      // open. Nothing is polling for that, so ask once here.
      if (answer.status === "ready") {
        void queryClient.invalidateQueries({ queryKey: getTranscriptQueryKey(projectId) });
      }
    },
  });
}

export function useProjectNotes(
  projectId: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<ProjectNotes, Error> {
  return useQuery({
    queryKey: getNotesQueryKey(projectId),
    queryFn: ({ signal }) => customFetch<ProjectNotes>(getNotesUrl(projectId), { signal, method: "GET" }),
    enabled: (options.enabled ?? true) && !!projectId,
  });
}

export function useCreateNote(
  projectId: string,
): UseMutationResult<ProjectNote, Error, { sourceMs: number; text: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      customFetch<ProjectNote>(getNotesUrl(projectId), { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: getNotesQueryKey(projectId) });
    },
  });
}

export function useDeleteNote(projectId: string): UseMutationResult<unknown, Error, { noteId: string }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ noteId }) =>
      customFetch<unknown>(`${getNotesUrl(projectId)}/${noteId}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: getNotesQueryKey(projectId) });
    },
  });
}
