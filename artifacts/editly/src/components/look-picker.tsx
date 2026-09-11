/**
 * Choosing the look captions are drawn in — the named styles, by sight.
 *
 * The catalogue lives in the worker (`CAPTION_STYLES`) and until now it was
 * reachable only by name: «هرموزي», "neon". A person who does not know the
 * names cannot ask, and a list of names is a list of words — the same failure
 * `FontPicker` documents, so this follows its rule: **every option is drawn
 * as itself**, a small CSS rendition of the burned look on a dark frame.
 * Approximations, not screenshots — close enough to choose by, cheap enough
 * to ship in the chunk.
 *
 * ## An act, not a setting
 *
 * `habits.ts` records the decision this product made about stated
 * preferences: they are a worse signal than demonstrated ones, and a settings
 * screen is a second place to say the same thing. So nothing here persists.
 * The choice rides with the next message or render (`look` beside `fonts`),
 * the sentence still wins where it spoke, and what actually renders is what
 * the habits arithmetic learns from — the picker is a faster way of saying
 * it, not a place where it is remembered.
 */
import type { CSSProperties, ReactNode } from "react";
import { Check } from "lucide-react";
import { useLanguage } from "@/lib/language";
import { LOOKS } from "@/lib/copy/editor";

export interface ChosenLook {
  style?: string;
  animation?: "none" | "pop" | "karaoke" | "kinetic" | "focus";
  pace?: "quick";
}

/** True when the choice would change anything — an empty look is not sent. */
export function lookSpeaks(look: ChosenLook): boolean {
  return Boolean(look.style || look.animation || look.pace);
}

/*
  One entry per catalogue style. `chip` draws the sample; the classes lean on
  inline styles because these twelve looks are exactly the place where twelve
  bespoke treatments is the point, not a smell. Colours are transcribed from
  the worker's own table (`CAPTION_STYLES`), primaries and accents alike, so
  the chip and the burn disagree only in resolution.
*/
type Sample = { ar: string; en: string };
const WORD: Sample = { ar: "الكابشن هنا", en: "captions here" };
const TWO = (s: Sample) => (lang: "ar" | "en") => (lang === "ar" ? s.ar : s.en);
const sample = TWO(WORD);

const BASE: CSSProperties = {
  fontWeight: 800,
  fontSize: 13,
  lineHeight: 1.2,
  letterSpacing: 0.2,
  whiteSpace: "nowrap",
};

export const LOOK_STYLES: Array<{
  id: string;
  render: (lang: "ar" | "en") => ReactNode;
}> = [
  {
    id: "bold-white",
    render: (l) => (
      <span style={{ ...BASE, color: "#fff", textShadow: "0 2px 6px rgba(0,0,0,.65)" }}>{sample(l)}</span>
    ),
  },
  {
    id: "bold-yellow",
    render: (l) => (
      <span style={{ ...BASE, color: "#ffe500", textShadow: "0 2px 6px rgba(0,0,0,.65)" }}>{sample(l)}</span>
    ),
  },
  {
    id: "hormozi",
    render: (l) => (
      <span style={{ ...BASE, color: "#fff", textTransform: "uppercase", textShadow: "0 3px 7px rgba(0,0,0,.7)" }}>
        {l === "ar" ? "الكلمة " : "the "}
        <span style={{ color: "#22c55e" }}>{l === "ar" ? "المهمة" : "BIG"}</span>
        {l === "ar" ? "" : " one"}
      </span>
    ),
  },
  {
    id: "beast",
    render: (l) => (
      <span style={{ ...BASE, color: "#ffd400", textTransform: "uppercase", textShadow: "0 3px 7px rgba(0,0,0,.7)" }}>
        {l === "ar" ? "أقوى " : "the "}
        <span style={{ color: "#ff3b30" }}>{l === "ar" ? "كلمة" : "LOUD"}</span>
        {l === "ar" ? "" : " one"}
      </span>
    ),
  },
  {
    id: "pill",
    render: (l) => (
      <span style={{ ...BASE, color: "#fff", textShadow: "0 2px 5px rgba(0,0,0,.55)" }}>
        {l === "ar" ? "خلف " : "box "}
        <span style={{ background: "#8b5cf6", borderRadius: 5, padding: "1px 5px" }}>
          {l === "ar" ? "الكلمة" : "behind"}
        </span>
      </span>
    ),
  },
  {
    id: "neon",
    render: (l) => (
      <span style={{ ...BASE, color: "#fff", textShadow: "0 0 6px #22d3ee, 0 0 14px #22d3ee" }}>{sample(l)}</span>
    ),
  },
  {
    id: "clean",
    render: (l) => (
      <span style={{ ...BASE, fontWeight: 700, fontSize: 12, color: "#fff", textShadow: "0 1px 4px rgba(0,0,0,.6)" }}>
        {sample(l)}
      </span>
    ),
  },
  {
    id: "bubble",
    render: (l) => (
      <span style={{ ...BASE, color: "#fff", textShadow: "0 4px 12px rgba(0,0,0,.95), 0 2px 5px rgba(0,0,0,.8)" }}>
        {sample(l)}
      </span>
    ),
  },
  {
    id: "creator",
    render: (l) => (
      <span style={{ ...BASE, color: "#fff", textShadow: "0 2px 6px rgba(0,0,0,.6)" }}>
        {l === "ar" ? "كلمة " : "one "}
        <span style={{ color: "#3ecf8e", fontSize: 16 }}>{l === "ar" ? "بارزة" : "keyword"}</span>
      </span>
    ),
  },
  {
    id: "karaoke-light",
    render: (l) => (
      <span style={{ ...BASE, background: "#fff", borderRadius: 6, padding: "2px 7px" }}>
        <span style={{ color: "#141414" }}>{l === "ar" ? "قيل " : "said "}</span>
        <span style={{ color: "#9a9a9a" }}>{l === "ar" ? "سيُقال" : "coming"}</span>
      </span>
    ),
  },
  {
    id: "karaoke-box",
    render: (l) => (
      <span style={{ ...BASE, background: "rgba(0,0,0,.78)", borderRadius: 6, padding: "2px 7px" }}>
        <span style={{ color: "#ffe500" }}>{l === "ar" ? "قيل " : "said "}</span>
        <span style={{ color: "#fff" }}>{l === "ar" ? "سيُقال" : "coming"}</span>
      </span>
    ),
  },
  {
    id: "label",
    render: (l) => (
      <span
        style={{ ...BASE, fontWeight: 700, fontSize: 12, color: "#fff", background: "rgba(38,38,38,.62)", borderRadius: 7, padding: "2px 8px" }}
      >
        {sample(l)}
      </span>
    ),
  },
];

const ANIMATIONS: Array<{ id: NonNullable<ChosenLook["animation"]> }> = [
  { id: "none" }, { id: "pop" }, { id: "karaoke" }, { id: "kinetic" }, { id: "focus" },
];

export function LookPicker({
  value,
  onChange,
  disabled,
}: {
  value: ChosenLook;
  onChange: (next: ChosenLook) => void;
  disabled?: boolean;
}) {
  const { t, language } = useLanguage();
  const lang: "ar" | "en" = language === "ar" ? "ar" : "en";

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-snug text-secondary/80">{t(LOOKS.lead)}</p>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" data-testid="look-styles">
        {LOOK_STYLES.map(({ id, render }) => {
          const chosen = value.style === id;
          return (
            <button
              key={id}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ ...value, style: chosen ? undefined : id })}
              aria-pressed={chosen}
              className={`relative rounded-lg border px-2 py-3 flex flex-col items-center gap-1.5 transition-colors ${
                chosen ? "border-secondary/70" : "border-hairline hover:border-secondary/30"
              }`}
              /* The dark frame every burn happens on. The chip is the look,
                 not a swatch beside its name. */
              style={{ background: "linear-gradient(165deg, #1c2230 0%, #10141d 100%)" }}
              data-testid={`look-style-${id}`}
            >
              <span dir={lang === "ar" ? "rtl" : "ltr"}>{render(lang)}</span>
              <span className="text-[10px] text-white/60">{t(LOOKS.styleNames[id as keyof typeof LOOKS.styleNames])}</span>
              {chosen && (
                <span className="absolute top-1.5 end-1.5 rounded-full bg-secondary/90 text-background p-0.5">
                  <Check className="w-3 h-3" />
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-1.5" data-testid="look-animations">
        <span className="text-[11px] text-muted-foreground me-1">{t(LOOKS.animationHeading)}</span>
        {ANIMATIONS.map(({ id }) => {
          const chosen = value.animation === id;
          return (
            <button
              key={id}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ ...value, animation: chosen ? undefined : id })}
              aria-pressed={chosen}
              className={`rounded-full border px-2.5 py-1 text-[11px] ${
                chosen ? "border-secondary/70 text-foreground" : "border-hairline text-muted-foreground"
              }`}
              data-testid={`look-animation-${id}`}
            >
              {t(LOOKS.animationNames[id])}
            </button>
          );
        })}
      </div>

      <label className="flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer select-none">
        <input
          type="checkbox"
          disabled={disabled}
          checked={value.pace === "quick"}
          onChange={(e) => onChange({ ...value, pace: e.target.checked ? "quick" : undefined })}
          data-testid="look-pace-quick"
        />
        {t(LOOKS.quickPace)}
      </label>
    </div>
  );
}
