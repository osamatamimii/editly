/**
 * A `fetch` that carries the session, for the endpoints the generated client
 * does not cover.
 *
 * Most of the app talks to the API through `@workspace/api-client-react`, which
 * is generated from the OpenAPI file and attaches the bearer token itself.
 * A few places do not: an upload that needs progress, a delete that returns a
 * count, anything added faster than the spec. Those were each writing their own
 * three lines to read the session and build a header — `project-library.tsx`,
 * `stock-search.tsx`, `project-clips.tsx` all have a private `authHeaders()`.
 *
 * Three copies of a line that attaches a credential is three places for one of
 * them to be forgotten, and a request that quietly goes out unauthenticated
 * gets a 401, which looks like a bug in the endpoint rather than in the caller.
 * So it lives here once.
 */
import { supabase } from "./supabase";

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;

  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  // Only when there is a body. Setting it on a GET makes some proxies expect
  // one, and a DELETE with a content-type and no body is a request that has
  // told the server something untrue about itself.
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(path, { ...init, headers });
}

/** The same, for the common case of "send JSON, read JSON". */
export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: T }> {
  const response = await apiFetch(path, init);
  // A body that is not JSON is a real answer to record rather than a throw:
  // the error handler on the server sends JSON for everything it knows about,
  // so anything else is an infrastructure page and the status is what matters.
  const body = (await response.json().catch(() => ({}))) as T;
  return { ok: response.ok, status: response.status, body };
}
