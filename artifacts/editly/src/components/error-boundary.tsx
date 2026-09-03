/**
 * The white screen, and the fact that nobody would ever hear about it.
 *
 * There was no error boundary anywhere in this app. One exception thrown while
 * React was rendering unmounted the whole tree, which is not a crash dialog and
 * not an error page: it is a blank white document, indistinguishable from a
 * page that has not loaded yet and from a person who closed the tab. Nothing
 * was logged on our side, because nothing on our side was involved.
 *
 * That is not hypothetical here. The day Osama said "most things aren't
 * working", the cause turned out to be a broken decoder in his browser, and the
 * only reason anybody found out is that he asked. A stranger does not ask. A
 * stranger closes the tab, and the product has no idea it happened.
 *
 * ## Three kinds of failure, and React only catches one
 *
 * An error boundary catches exceptions thrown **during render**, in lifecycle
 * methods, and in constructors. It does not catch anything thrown from an event
 * handler, from a `setTimeout`, or from a promise nobody awaited — and between
 * them those are the common case in an app that spends its life waiting on
 * uploads and renders. A boundary alone would have caught the rarest kind and
 * reported nothing about the rest, while looking like coverage.
 *
 * So `watchForCrashes` wires `error` and `unhandledrejection` on `window` as
 * well. Those two **report and do not replace the screen**, and the difference
 * is deliberate: a failed background fetch is not a reason to blank somebody's
 * editor, and a boundary that swallowed the whole app every time a promise
 * rejected would be a worse bug than the one it was added for.
 *
 * ## What is sent, and what is deliberately not
 *
 * The message, the component, and the pathname. No field contents, no bearer
 * token, no email, no query string — an OAuth error puts a code in the query,
 * and the crash reporter is the last place that should be copying it out. The
 * request carries no credentials for the same reason.
 *
 * It goes to our own API. No third-party service, no new account, no script
 * from a domain the privacy policy would then have to name: a line in our own
 * log answers the only question anybody has, which is whether this is
 * happening at all.
 *
 * ## The reference
 *
 * A short code, shown on the screen and sent with the report. It is the whole
 * difference between "it broke" and a support message somebody can act on:
 * with it, a sentence in a chat window finds one line in a log.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { directionOf, say } from "@/lib/landing-copy";
import { storedLanguage } from "@/lib/language-routes";
import { CRASH } from "@/lib/copy/chrome";

/** Where the report goes. Same origin, so no CORS and no third party. */
const ENDPOINT = "/api/client-errors";

/** Caps, matched to the ones the route enforces. Truncated here so the route
 *  never has to refuse a report it could have kept the useful half of. */
const MESSAGE_MAX = 300;
const COMPONENT_MAX = 300;

export type CrashKind = "render" | "promise" | "handler";

export interface CrashReport {
  kind: CrashKind;
  message: string;
  /** The first component frame React named, when there is one. */
  component: string | null;
  /** Pathname only. Never the query, never the hash. */
  path: string;
  reference: string;
}

/**
 * Six characters somebody can read down a phone line.
 *
 * Not a uuid: this is going to be typed into a chat window by a person who is
 * annoyed, and thirty-six characters of hexadecimal is a reference nobody
 * quotes. Uniqueness only has to hold across the reports in a log, not across
 * the universe.
 */
function reference(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

/** The pathname, with everything that could carry a secret removed. */
function safePath(): string {
  try {
    return window.location.pathname.slice(0, 200);
  } catch {
    return "unknown";
  }
}

/**
 * Send it, and never let sending it be the thing that breaks.
 *
 * `keepalive` because a crash is often followed immediately by a reload, and a
 * report that dies with the document is a report that never explains the crash
 * anybody is reloading away from. No credentials: the server does not need to
 * know who this was, and a report is not worth attaching somebody's session to.
 */
export function reportCrash(report: CrashReport): void {
  try {
    void fetch(ENDPOINT, {
      method: "POST",
      credentials: "omit",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: report.kind,
        message: report.message.slice(0, MESSAGE_MAX),
        component: report.component ? report.component.slice(0, COMPONENT_MAX) : null,
        path: report.path,
        reference: report.reference,
      }),
    }).catch(() => {
      /* A reporter that throws on a broken network is a second crash on top of
         the first, and this one would be inside the screen apologising for it. */
    });
  } catch {
    /* `fetch` itself missing, which is old browsers and locked-down webviews. */
  }
}

/**
 * The first component React names in its stack.
 *
 * `componentStack` is a list of frames beginning with a newline and a tab. The
 * first one is the component that threw, which is the single most useful word
 * in the whole report, and the rest is the tree above it — long, mostly
 * providers, and not worth a database column.
 */
export function componentFrom(info: { componentStack?: string | null } | null): string | null {
  const stack = info?.componentStack ?? "";
  const first = stack.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  return first ? first.replace(/^(in|at)\s+/, "").slice(0, COMPONENT_MAX) : null;
}

/**
 * Everything a boundary cannot see, wired explicitly.
 *
 * Returns its own undo, so a caller can install this once and a test can take
 * it back out. Reports only: see the header on why neither of these replaces
 * the screen.
 */
export function watchForCrashes(target: Window = window): () => void {
  const onError = (event: ErrorEvent) => {
    reportCrash({
      kind: "handler",
      message: String(event.message ?? event.error ?? "unknown error"),
      component: null,
      path: safePath(),
      reference: reference(),
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason as { message?: unknown } | string | undefined;
    reportCrash({
      kind: "promise",
      message: String(
        (typeof reason === "object" && reason !== null && "message" in reason ? reason.message : reason) ??
          "unhandled rejection",
      ),
      component: null,
      path: safePath(),
      reference: reference(),
    });
  };

  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection as EventListener);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection as EventListener);
  };
}

interface BoundaryState {
  message: string | null;
  reference: string;
}

/**
 * The screen instead of the white one.
 *
 * Three things and nothing else: what broke, a way to try again, and a code to
 * quote. The message is shown rather than hidden behind "something went wrong",
 * because a person who can see "Cannot read properties of undefined" at least
 * knows it is not their file and not their connection, and the ones who cannot
 * read it are no worse off than they were staring at nothing.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { message: null, reference: "" };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    const message = error instanceof Error ? error.message : String(error);
    return { message: message || say(CRASH.stopped, storedLanguage()), reference: reference() };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportCrash({
      kind: "render",
      message: error instanceof Error ? error.message : String(error),
      component: componentFrom(info),
      path: safePath(),
      reference: this.state.reference,
    });
  }

  override render(): ReactNode {
    if (this.state.message === null) return this.props.children;

    /*
      Read here rather than taken from the provider, and the reason is
      structural: this boundary is mounted *above* `LanguageProvider` in
      `App.tsx`, because a boundary inside the tree it is catching cannot
      render when that tree is what threw. So it reads the stored preference,
      which is the same key the provider reads and the same one the script in
      `index.html` reads before the first paint.
    */
    const language = storedLanguage();

    return (
      <div
        className="min-h-screen flex items-center justify-center p-6 bg-background text-foreground"
        lang={language}
        dir={directionOf(language)}
        data-testid="crash-screen"
      >
        <div className="max-w-md w-full text-center space-y-4">
          <h1 className="text-2xl font-bold">{say(CRASH.title, language)}</h1>
          <p className="text-muted-foreground">{say(CRASH.lead, language)}</p>
          {/* The actual message. Small, monospaced, and present: a person who
              can read it learns it is not their file and not their connection. */}
          <p
            className="text-xs font-mono break-words rounded-lg border border-hairline-faint p-3 text-muted-foreground"
            data-testid="crash-message"
          >
            {this.state.message}
          </p>
          <button
            type="button"
            className="rounded-full px-6 h-12 bg-primary text-primary-foreground font-semibold"
            onClick={() => window.location.reload()}
            data-testid="crash-reload"
          >
            {say(CRASH.reload, language)}
          </button>
          <p className="text-xs text-muted-foreground">
            {say(CRASH.quoteThis, language)}
            <span className="font-mono" dir="ltr" data-testid="crash-reference">
              {this.state.reference}
            </span>
          </p>
        </div>
      </div>
    );
  }
}
