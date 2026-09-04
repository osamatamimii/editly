/**
 * The project's library: everything this edit can put on screen besides the one
 * video being cut.
 *
 * It talks to the API with plain fetch rather than through the generated client
 * because the generated client is produced from the OpenAPI spec, and a panel
 * that cannot ship until the spec is regenerated is a panel that does not ship.
 * The endpoints it calls are three, and they are stable.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Trash2, ImageIcon, Film, Music, Plus } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { uploadProjectAsset, formatBytes, assetKindOf } from "@/lib/video-storage";
import { StockSearch } from "./stock-search";
import { useLanguage } from "@/lib/language";
import { LIBRARY } from "@/lib/copy/editor";
import { phrase as p } from "@/lib/landing-copy";

/*
  Three sentences this panel says that `LIBRARY` has no entry for.

  They arrived with the load-state and nullable-ceiling fixes, after the copy
  table had been written, and each exists because of a state the table does not
  model: a list that could not be read, a delete the server refused, and an
  empty library whose size limit is not known yet. They are written here rather
  than left in English, because a screen on `BILINGUAL` that says one sentence
  in English is the exact bug `lib/language.tsx` is about. They belong in
  `lib/copy/editor.ts` beside the rest of `LIBRARY` and should move there on
  the next pass through that file.
*/
const LIBRARY_STATES = {
  /** The list did not load. Distinct from "you have no files", deliberately. */
  unreadable: p(
    "تعذّرت قراءة هذه القائمة الآن. ملفاتك ما زالت هنا، وهذه اللوحة وحدها هي الغائبة. أضف ملفًا وستُحاول من جديد.",
    "We could not read this list just now. Your files are still here; this panel is not. Adding one will try again.",
  ),
  /** A refused delete, said out loud instead of looking like a dead button. */
  couldNotRemove: p(
    "تعذّر حذف هذا الملف. حاول مرّة أخرى.",
    "That file could not be removed. Please try again.",
  ),
  /*
    The empty library, with no size named.

    `LIBRARY.empty` ends by naming the per-file ceiling, and the ceiling is not
    known until the subscription answers. Quoting the wrong number is worse
    than quoting none, so while it is null this half of the pair is said and
    the sentence simply stops.
  */
  emptyCeilingUnknown: p(
    "لا شيء بعد. الملفات التي تضيفها هنا يمكن قصّها كلقطات إضافية، أو وضعها فوق الكادر، أو تشغيلها تحت التعديل كلّه إن كانت موسيقى تملك حقوقها.",
    "Nothing yet. Files you add here can be cut in as b-roll, laid over the frame, or, if it is a track you have the rights to, played under the whole edit.",
  ),
} as const;

export interface ProjectAsset {
  id: string;
  kind: "video" | "image" | "audio";
  label: string | null;
  bytes: number;
}

const ICON = { video: Film, image: ImageIcon, audio: Music } as const;

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function ProjectLibrary({
  projectId,
  ceiling,
}: {
  projectId: string;
  /**
   * The bucket's real ceiling, handed down rather than looked up here, and
   * null while the server has not said what it is.
   *
   * The editor already reads it from the subscription for the source video,
   * and two components asking separately is two chances to answer differently
   * — a product that refuses a file on one panel and accepts it on the next.
   *
   * Nullable because the alternative is worse than not knowing: the build-time
   * fallback is 50 MB, the free plan's order of magnitude, so folding "not
   * answered yet" into it told a Pro customer to keep each extra file under
   * fifty megabytes. See `servedCeiling`.
   */
  ceiling: number | null;
}) {
  const { t, fmt } = useLanguage();
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Which file of how many, so a ten-file drop does not look frozen. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /*
    Whether the last read of this list worked.

    Without it, a failed read left `assets` at `[]` and the panel said "Nothing
    yet. Files you add here can be cut in as b-roll…" — the same words a project
    with no files gets. So a person whose upload succeeded and whose refetch
    then 500'd watched their b-roll disappear, and either uploaded it again or
    concluded the feature was broken.

    This is the distinction `lib/load-state.ts` exists to keep, in a component
    that was bypassing it.
  */
  const [unreadable, setUnreadable] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/assets`, { headers: await authHeaders() }).catch(
      () => null,
    );
    if (!res || !res.ok) {
      setUnreadable(true);
      return;
    }
    setUnreadable(false);
    // `as ProjectAsset[]` is a promise the compiler cannot keep. Anything that
    // answers 200 with something that is not an array — an error envelope, a
    // proxy's own JSON, a later version of this endpoint that wraps the list —
    // lands in state, and the next line to touch it is `assets.map`, which
    // throws. That throw is not a missing list: it is a blank screen where the
    // whole editor was, because a render error unmounts the tree above it.
    //
    // The list is the least important thing on this page. Failing to load it
    // must cost the list, and nothing else.
    const body: unknown = await res.json().catch(() => null);
    setAssets(Array.isArray(body) ? (body as ProjectAsset[]) : []);
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function add(files: FileList): Promise<void> {
    setError(null);
    setBusy(true);
    const list = Array.from(files);
    setProgress({ done: 0, total: list.length });

    // Sequential on purpose. Ten parallel uploads from a phone share one uplink
    // and finish no sooner, but they do make the progress meaningless and make
    // a failure halfway impossible to describe.
    const failures: string[] = [];
    for (const [index, file] of list.entries()) {
      try {
        if (!assetKindOf(file)) throw new Error(fmt(LIBRARY.notMedia, file.name));
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) throw new Error(t(LIBRARY.sessionExpired));

        const { path, kind } = await uploadProjectAsset({ file, projectId, accessToken: token, ceiling });
        const res = await fetch(`/api/projects/${projectId}/assets`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await authHeaders()) },
          body: JSON.stringify({ path, kind, label: file.name, bytes: file.size }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? fmt(LIBRARY.couldNotAdd, file.name));
        }
      } catch (e) {
        failures.push(e instanceof Error ? e.message : fmt(LIBRARY.couldNotAdd, file.name));
      }
      setProgress({ done: index + 1, total: list.length });
    }

    // Whatever did land is shown, and whatever did not is named. A batch that
    // half-worked must not report as either success or failure.
    await refresh();
    setBusy(false);
    setProgress(null);
    if (failures.length > 0) setError(failures.join(" "));
  }

  async function remove(id: string): Promise<void> {
    setError(null);
    // The answer was being discarded, so a refused delete looked exactly like a
    // successful one that the list then re-rendered unchanged: the file is
    // still there, nothing is said, and the only reading available is that the
    // button does not work.
    const res = await fetch(`/api/projects/${projectId}/assets/${id}`, {
      method: "DELETE",
      headers: await authHeaders(),
    }).catch(() => null);
    if (!res || !res.ok) {
      const body = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
      setError(body.error ?? t(LIBRARY_STATES.couldNotRemove));
    }
    await refresh();
  }

  return (
    <div className="rounded-xl glass-panel border border-hairline px-4 py-4" data-testid="project-library">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <div className="text-sm font-medium">{t(LIBRARY.title)}</div>
          <div className="text-xs text-muted-foreground">{t(LIBRARY.lead)}</div>
        </div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          data-testid="button-add-assets"
          className="inline-flex flex-shrink-0 whitespace-nowrap items-center gap-1.5 rounded-lg border border-hairline bg-surface-1 px-3 min-h-11 md:min-h-0 md:py-2 text-xs font-medium transition-all hover:border-primary/40 disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          {busy && progress ? fmt(LIBRARY.adding, progress.done, progress.total) : t(LIBRARY.addFiles)}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="video/*,image/*,audio/*"
          className="hidden"
          onChange={(e) => {
            const files = e.target.files;
            e.target.value = "";
            if (files && files.length > 0) void add(files);
          }}
        />
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs" role="alert">
          {error}
        </div>
      )}

      {unreadable ? (
        <div className="text-xs text-muted-foreground" data-testid="library-unreadable">
          {t(LIBRARY_STATES.unreadable)}
        </div>
      ) : assets.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          {/* The size is named only when it is known. A sentence that quotes
              the wrong number is worse than one that quotes none: this panel
              was telling paying customers a free plan's limit for as long as
              the subscription query was in flight. */}
          {ceiling !== null
            ? fmt(LIBRARY.empty, formatBytes(ceiling))
            : t(LIBRARY_STATES.emptyCeilingUnknown)}
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {assets.map((asset) => {
            const Icon = ICON[asset.kind];
            return (
              <li
                key={asset.id}
                className="flex items-center gap-2.5 rounded-lg border border-hairline bg-surface-1 px-3 py-2"
                data-testid={`asset-${asset.id}`}
              >
                <Icon className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />
                <span dir="auto" className="text-xs truncate flex-1" title={asset.label ?? asset.id}>
                  {asset.label ?? asset.id}
                </span>
                <span className="text-[10px] text-muted-foreground flex-shrink-0">{formatBytes(asset.bytes)}</span>
                <button
                  type="button"
                  onClick={() => void remove(asset.id)}
                  aria-label={fmt(LIBRARY.removeFile, asset.label ?? t(LIBRARY.thisFile))}
                  className="text-muted-foreground hover:text-destructive transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <StockSearch projectId={projectId} onAdded={refresh} ceiling={ceiling} />
    </div>
  );
}
