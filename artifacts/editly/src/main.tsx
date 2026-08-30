import { createRoot } from "react-dom/client";
import App from "./App";
import { captureOAuthError } from "./lib/oauth";
import "./index.css";

/**
 * Before anything renders.
 *
 * A failed OAuth redirect comes back to `/dashboard` carrying its reason on the
 * URL. There is no session, so the router redirects to `/login` — and that
 * redirect drops the query and the hash. Read here, the reason survives the
 * redirect; read anywhere else, it is already gone.
 */
captureOAuthError();

createRoot(document.getElementById("root")!).render(<App />);
