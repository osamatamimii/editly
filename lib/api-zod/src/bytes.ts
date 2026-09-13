/**
 * One number, written the way a person reads it — and nothing else in the file.
 *
 * This function used to live at the bottom of `uploads.ts`, next to the
 * schemas it shares a subject with, which is where it belongs by meaning and
 * exactly the wrong place by weight.
 *
 * `uploads.ts` opens with `import { z } from "zod"` and then calls `z.object`
 * some twenty times at module scope. A bundler cannot drop those calls — a
 * top-level call might do anything, so it has to be kept — which means that
 * importing *one identifier* from that module pulls the whole of zod in behind
 * it. The landing page imports `formatBytes` to say "under 2.0 GB" beside a
 * file picker, and paid 55kB unpacked, 13kB over the wire, for a validation
 * library it never calls, on the first screen a stranger ever sees.
 *
 * `caption-default.ts` already carries a note about this same hazard, written
 * when it bit the worker's bundle. So this is the second time in this repo
 * that a value import reached zod through a door nobody meant to open, and the
 * fix is the one that file chose: a module with no dependencies, imported by
 * the people who only want the helper.
 *
 * `uploads.ts` re-exports it, so every existing importer keeps working and the
 * server — which has zod loaded regardless — need not care where it lives.
 */

/**
 * Bytes as a person reads them.
 *
 * Here rather than in the browser because the sentence that names a ceiling is
 * now written on the server, and the same file printing two different sizes on
 * the two sides of one refusal is the kind of small wrongness that makes a
 * person distrust the number entirely.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
