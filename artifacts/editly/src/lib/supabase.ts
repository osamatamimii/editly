import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set. Copy .env.example to .env.local and fill them in.",
  );
}

export const supabase = createClient(url, anonKey, {
  auth: {
    // Keeps the user signed in across reloads and refreshes the access token
    // before it expires, so the API never sees an avoidable 401.
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
