export * from "./generated/api";
export * from "./generated/api.schemas";
export * from "./render";
export * from "./notes";
/*
  `customFetch` is exported alongside the three setters because the app has a
  call our own generated client does not cover — minting a read URL for a
  stored object — and the alternative was that file reading the access token
  itself. A second copy of an auth rule is how one of them comes to be the
  stale one: Supabase rotates the token about hourly, and the getter
  registered in `auth.tsx` reads it at call time for exactly that reason.
*/
export { customFetch, setBaseUrl, setAuthTokenGetter, setLanguageGetter } from "./custom-fetch";
export type { AuthTokenGetter } from "./custom-fetch";
