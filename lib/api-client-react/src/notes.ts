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
