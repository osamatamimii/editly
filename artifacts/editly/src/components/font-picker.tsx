/**
 * Choosing the face captions are drawn in.
 *
 * Two lists, one per script, because a caption track can carry both and each
 * needs its own: picking a condensed Latin display face says nothing about
 * what the Arabic lines in the same video should look like.
 *
 * ## Every option is drawn in itself
 *
 * A list of font names set in the page's own font is a list of words. You
 * cannot choose a typeface from its name, and the one thing a person wants
 * from this control is to see the thing before committing a render to it.
 *
 * So each option is drawn in its own face, from a subset of that exact file —
 * the same bytes the renderer burns with, cut down to the sample text. Twelve
 * of them come to about eighty kilobytes, fetched only when this panel opens,
 * because a `@font-face` is fetched when something uses it and nothing here
 * uses one until it is on screen.
 *
 * The sample is a sentence rather than the alphabet: "AaBbCc" tells you about
 * letterforms and nothing about rhythm, and what a caption is made of is
 * rhythm.
 */
import { CAPTION_FACES, DEFAULT_FACE, type FaceScript } from "@workspace/api-zod/fonts";
import { Check } from "lucide-react";
import { FontUpload, type UploadedFace } from "@/components/font-upload";
import { signedVideoUrl } from "@/lib/video-storage";
import { useEffect } from "react";

export interface ChosenFonts {
  latin: string;
  arabic: string;
}

export const DEFAULT_FONTS: ChosenFonts = {
  latin: DEFAULT_FACE.latin,
  arabic: DEFAULT_FACE.arabic,
};

/** What each list is shown drawing. Long enough to have a rhythm. */
const SAMPLE: Record<FaceScript, string> = {
  latin: "Nobody tells you this",
  arabic: "لا أحد يخبرك بهذا",
};

/**
 * The rows a list draws: the ones we ship, then the ones this person uploaded
 * and we measured.
 *
 * Only `ready` uploads. A font still being measured has no numbers yet, so a
 * caption in it would be drawn at a guessed size — and offering it would mean
 * a person picks a face and gets a different one. The ones that are not ready
 * are shown by `FontUpload` underneath, where the status is the point.
 */
function rowsFor(script: FaceScript, uploaded: UploadedFace[]) {
  return [
    ...CAPTION_FACES.filter((face) => face.script === script).map((face) => ({
      id: face.id,
      label: face.label,
      note: face.note,
      /** The family the picker draws this option in. Ours ship as `editly-<id>`. */
      cssFamily: `editly-${face.id}`,
    })),
    ...uploaded
      .filter((face) => face.script === script && face.status === "ready")
      .map((face) => ({
        id: face.id,
        label: face.label,
        note: face.declared ?? "Your font",
        cssFamily: `editly-upload-${face.id}`,
      })),
  ];
}

function FaceList({
  script,
  chosen,
  onChoose,
  disabled,
  uploaded,
}: {
  script: FaceScript;
  chosen: string;
  onChoose: (id: string) => void;
  disabled?: boolean;
  uploaded: UploadedFace[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {rowsFor(script, uploaded).map((face) => {
        const picked = face.id === chosen;
        return (
          <button
            key={face.id}
            type="button"
            disabled={disabled}
            onClick={() => onChoose(face.id)}
            aria-pressed={picked}
            className={`w-full text-left rounded-xl px-3 py-2.5 border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              picked
                ? "border-primary/60 bg-primary/10"
                : "border-hairline bg-surface-1 hover:border-primary/30 hover:bg-white/[0.05]"
            }`}
            data-testid={`button-face-${face.id}`}
          >
            <span className="flex items-baseline justify-between gap-3">
              {/*
                The sample, in the face itself, at a size where a typeface is
                actually distinguishable. `dir="auto"` for the same reason it is
                on every other place in this product that draws a sentence.
              */}
              <span
                dir="auto"
                className="text-xl leading-tight truncate"
                style={{ fontFamily: `"${face.cssFamily}", system-ui, sans-serif` }}
              >
                {SAMPLE[script]}
              </span>
              {picked ? <Check className="w-4 h-4 text-primary flex-shrink-0" /> : null}
            </span>
            <span className="flex items-baseline gap-2 mt-1">
              <span className="text-xs font-medium text-foreground/80 flex-shrink-0">{face.label}</span>
              <span dir="auto" className="text-xs text-muted-foreground leading-snug truncate">
                {face.note}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Draw each uploaded option in its own face, the way the thirteen shipped ones
 * are drawn.
 *
 * The shipped faces have a `@font-face` in the stylesheet, because their files
 * are in the bundle. An uploaded one lives in this person's private storage
 * and needs a signed URL, which is not a thing a stylesheet can hold — so the
 * face is registered at runtime instead, from the same subset the picker would
 * have linked.
 *
 * A load that fails is left alone. `system-ui` is the fallback in the style
 * below, so the option is still a row with a name in it rather than nothing;
 * the sample being in the wrong face is worth saying nothing about, because the
 * one thing a person cannot do about it is anything.
 */
function useUploadedFaceFiles(uploaded: UploadedFace[]) {
  const ready = uploaded
    .filter((face) => face.status === "ready" && face.previewPath)
    .map((face) => `${face.id}:${face.previewPath}`)
    .join(",");

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void (async () => {
      for (const entry of ready.split(",")) {
        const [id, ...rest] = entry.split(":");
        const path = rest.join(":");
        const family = `editly-upload-${id}`;
        // Already registered from a previous open of this panel. Loading it
        // again would sign a second URL and fetch the same bytes.
        if ([...document.fonts].some((f) => f.family === family)) continue;
        const url = await signedVideoUrl(path);
        if (!url || cancelled) continue;
        try {
          const face = new FontFace(family, `url(${JSON.stringify(url)})`);
          await face.load();
          if (!cancelled) document.fonts.add(face);
        } catch {
          // See above: the row still reads, in the fallback face.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready]);
}

export function FontPicker({
  value,
  onChange,
  disabled,
  uploaded = [],
  userId,
  accessToken,
  onFontsChanged,
}: {
  value: ChosenFonts;
  onChange: (next: ChosenFonts) => void;
  disabled?: boolean;
  /** Faces this person uploaded, in every state. */
  uploaded?: UploadedFace[];
  userId?: string;
  accessToken?: string | null;
  onFontsChanged?: () => void;
}) {
  useUploadedFaceFiles(uploaded);
  return (
    <div className="flex flex-col gap-4" data-testid="font-picker">
      <p className="text-xs text-muted-foreground leading-snug">
        What captions are drawn in. The next render uses it; the ones already made keep the face they
        were made with.
      </p>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-muted-foreground">English and Latin</span>
        <FaceList
          script="latin"
          chosen={value.latin}
          disabled={disabled}
          uploaded={uploaded}
          onChoose={(latin) => onChange({ ...value, latin })}
        />
        {userId && onFontsChanged ? (
          <FontUpload
            script="latin"
            faces={uploaded}
            accessToken={accessToken ?? null}
            onChanged={onFontsChanged}
            disabled={disabled}
          />
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-muted-foreground">العربية</span>
        {/*
          Both lists, always, rather than one chosen from the project's
          language. A person who records in Arabic and drops an English product
          name into a sentence gets both faces in the same caption track, and
          the second one is not a setting they should have to go and find.
        */}
        <FaceList
          script="arabic"
          chosen={value.arabic}
          disabled={disabled}
          uploaded={uploaded}
          onChoose={(arabic) => onChange({ ...value, arabic })}
        />
        {userId && onFontsChanged ? (
          <FontUpload
            script="arabic"
            faces={uploaded}
            accessToken={accessToken ?? null}
            onChanged={onFontsChanged}
            disabled={disabled}
          />
        ) : null}
      </div>
    </div>
  );
}
