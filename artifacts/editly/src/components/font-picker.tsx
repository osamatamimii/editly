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

function FaceList({
  script,
  chosen,
  onChoose,
  disabled,
}: {
  script: FaceScript;
  chosen: string;
  onChoose: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {CAPTION_FACES.filter((face) => face.script === script).map((face) => {
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
                style={{ fontFamily: `"editly-${face.id}", system-ui, sans-serif` }}
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

export function FontPicker({
  value,
  onChange,
  disabled,
}: {
  value: ChosenFonts;
  onChange: (next: ChosenFonts) => void;
  disabled?: boolean;
}) {
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
          onChoose={(latin) => onChange({ ...value, latin })}
        />
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
          onChoose={(arabic) => onChange({ ...value, arabic })}
        />
      </div>
    </div>
  );
}
