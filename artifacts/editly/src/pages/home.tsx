import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Play, Sparkles, Zap, CheckCircle2, ArrowRight, Check, Upload, MessageSquareText, Send, ChevronLeft, Download } from "lucide-react";
import { useGetSubscription, useUpdateSubscription, getGetSubscriptionQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { fetchCheckoutConfig, openCheckout } from "@/lib/checkout";
import { useAuth } from "@/lib/auth";
import { Logo } from "@/components/logo";
import { RollingNumber } from "@/components/rolling-number";
import { PLANS, SHARED_FEATURES, FREE_TIER } from "@/lib/pricing";
import {
  LANDING,
  PRICING_AR,
  directionOf,
  phrase,
  say,
  type Language,
  type Phrase,
} from "@/lib/landing-copy";
import { useLanguage } from "@/lib/language";

/**
 * How long `.reveal`'s filter transition is given before the filter is dropped.
 *
 * Deliberately longer than the 0.7s the stylesheet spends on it: finishing the
 * blur early would be visible, and finishing it late costs one element a few
 * extra frames on the filter path, once.
 */
const REVEAL_SETTLE_MS = 1000;

/** Tailwind's `sm`. Below it the app renders its phone layout, and so does the
 *  recording of the app. */
const PHONE_QUERY = "(max-width: 639px)";

/**
 * Whether this is a phone-width screen, as a value the render can branch on.
 *
 * Server-safe default is `false`: a first paint that guesses desktop and
 * corrects itself costs one swap of a `src` that had not started loading,
 * whereas guessing phone would put the small recording on every desktop for a
 * frame.
 */
function usePhoneWidth(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(PHONE_QUERY);
    const sync = () => setPhone(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return phone;
}

/**
 * Which language this page is in, and how that is decided.
 *
 * Arabic by default, and that is a position rather than an oversight. The first
 * audience for this product is Arabic-speaking, the product underneath has been
 * bilingual since the first render note, and a landing page that opens in
 * English tells that audience the tool was built for somebody else. Phones in
 * the region are very often set to English, so reading `navigator.language`
 * would have quietly turned "Arabic first" into "English for nearly everyone",
 * which is the decision this is not.
 *
 * Two things override it, in this order: `?lang=` on the URL, because a link is
 * how this page gets handed to somebody; and what they chose last time, so the
 * switch is worth pressing once.
 *
 * All of that now lives in `lib/language.tsx` and is shared with the rest of
 * the product, which is the point: this page kept the choice under its own key,
 * so somebody who read the marketing in English, signed up, and came back to
 * the landing page was asked again. The preference belongs to the person, not
 * to the page.
 */
function useLandingLanguage(): [Language, (next: Language) => void] {
  const { language, choose } = useLanguage();
  return [language, choose];
}

/**
 * Mirroring a drawing, and which drawings get mirrored.
 *
 * SVG has no logical properties: an `x` is a number of user units from the left
 * edge whichever way the page reads. So a diagram whose meaning is a *flow*
 * reads backwards in Arabic unless it is turned round, and the cheapest honest
 * way to turn one round is to mirror the whole shape layer and place the text
 * on top of it.
 *
 * The line is between a drawing of a **process** and a drawing of a **scene**.
 * The step cards are processes: the take on one side, what came out on the
 * other, a dotted line between them, and in Arabic that runs the other way. The
 * hero's room is a scene: a person sitting off to one side of a frame because
 * that is where a phone on a desk puts them. Mirroring a photograph because the
 * caption is in Arabic is not a translation, it is a different photograph.
 *
 * `MIRROR` goes on the shapes; the text sits outside it and takes its position
 * from `mirrored`, because a `scale(-1,1)` on a `<text>` renders the letters
 * backwards.
 */
const MIRROR = "translate(320,0) scale(-1,1)";
/** The same, for the square cells in the feature grid. */
const MIRROR_CELL = "translate(120,0) scale(-1,1)";

/**
 * A text anchor, moved to the other side of a mirrored drawing.
 *
 * The `x` half is arithmetic and was always right. The *anchor* half was
 * wrong for every Arabic label in these drawings, and wrong in the way that is
 * hardest to see in a diff: `text-anchor: start` and `end` are not left and
 * right, they are the two ends of the **inline base direction**, and the base
 * direction inside these `<svg>`s is inherited from the page. On the Arabic
 * page that is `rtl`, where `start` already means the right-hand side.
 *
 * So flipping the anchor as well as the coordinate flipped it twice. Every
 * Arabic label anchored itself on the wrong end and ran the wrong way out of
 * the drawing: «اقصّ الفراغات وخلّيه» started at x=226 in a 320-wide viewBox
 * and ended at 344, off the edge — measured, not guessed. Nothing threw and
 * the SVG viewport clipped it, so at the size these were drawn before (a
 * 320px card) it read as a slightly cropped label rather than as a bug. At
 * four times the size, in the pinned frame, it is the first thing you see.
 *
 * `latin` is the exception and it is a real one: the file names and timecodes
 * carry `direction: ltr` of their own, because `raw-take.mov` and `12:04` must
 * not be reordered by the paragraph around them. Those really are laid out
 * left-to-right inside a right-to-left drawing, so for them — and only for
 * them — the anchor does have to flip with the coordinate.
 */
function mirrored(
  x: number,
  anchor: "start" | "end",
  rtl: boolean,
  width = 320,
  latin = false,
) {
  if (!rtl) return { x, textAnchor: anchor };
  const flipped = anchor === "end" ? ("start" as const) : ("end" as const);
  return { x: width - x, textAnchor: latin ? flipped : anchor };
}

function useScrollReveal() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    /*
     * `visible` starts the reveal; `settled` ends it, and the second one is
     * what makes the page scrollable.
     *
     * A CSS transition cannot land on `filter: none` — only on `blur(0)` — so
     * every element that had finished revealing kept a live filter and its own
     * composited layer for the rest of the session. Eighteen of them, several
     * over 200,000px, measured 141 janky frames out of 150 while scrolling.
     * The timer removes the filter once it has done its work.
     *
     * `transitionend` would be the tidier signal and is not reliable here: it
     * does not fire for an element whose transition never runs because it was
     * already off-screen when the class landed, and it fires once per property,
     * so it needs filtering anyway. A timer that is a little long cannot leave
     * an element stuck blurred.
     */
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const target = entry.target;
          target.classList.add("visible");
          observer.unobserve(target);
          const timer = setTimeout(() => {
            target.classList.add("settled");
            timers.delete(timer);
          }, REVEAL_SETTLE_MS);
          timers.add(timer);
        });
      },
      { threshold: 0.15 }
    );
    const children = el.querySelectorAll(".reveal");
    children.forEach((child) => observer.observe(child));
    return () => {
      observer.disconnect();
      timers.forEach(clearTimeout);
    };
  }, []);
  return ref;
}

/**
 * Whether the page has moved far enough for the top bar to collapse.
 *
 * The bar has two states and the second one is a different object: at rest it
 * is the full width of the page, part of the hero, with nothing behind it. Once
 * you move, it gathers itself into a capsule that floats over whatever is
 * passing underneath — narrower, rounded all the way, lifted by a shadow rather
 * than divided by a rule.
 *
 * A rAF-throttled passive listener rather than a bare `scroll` handler: reading
 * `scrollY` is a layout read, and doing one per scroll event on a phone is the
 * classic way to make the one element that is always on screen stutter. One
 * read per frame, at most, and only when the boolean actually flips does React
 * hear about it.
 *
 * The threshold is deliberately small. A bar that waits 200px to collapse feels
 * broken for the first flick of the wheel; 24px is "you have started moving".
 */
function useNavState(threshold = 24): { collapsed: boolean; overDark: boolean } {
  const [state, setState] = useState({ collapsed: false, overDark: false });
  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      /*
       * Glass takes the colour of what is behind it, and one section of this
       * page is nearly black. At the tint the bar now carries that came out as
       * a mid-grey smudge with the bar's own dark labels printed on it —
       * measured at 2.0:1, which is not a contrast ratio, it is a guess. The
       * bar cannot be light over that section, so it stops being light: the
       * band's own rect says when, and the header takes the dark palette while
       * it is inside it.
       *
       * Read from the band rather than from a scroll offset. An offset is a
       * number that was true when it was written down and stops being true the
       * next time anything above it changes height.
       */
      const band = document.querySelector(".horizon-band");
      const r = band?.getBoundingClientRect();
      /* The bar's own foot, not the viewport's: it is what the dark has to
         reach before the labels are sitting on it. */
      const foot = NAV_FOOT;
      const overDark = !!r && r.top <= foot && r.bottom >= 0;
      const collapsed = window.scrollY > threshold;
      setState((prev) =>
        prev.collapsed === collapsed && prev.overDark === overDark ? prev : { collapsed, overDark },
      );
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [threshold]);
  return state;
}
/** The collapsed bar's lowest pixel, which is what the dark has to reach. */
const NAV_FOOT = 66;

/**
 * The hero's waveform, written down rather than generated.
 *
 * `Math.random()` here would give every visitor a different picture and every
 * screenshot in this repo a different diff, for a shape nobody reads as data.
 * These are the amplitudes of the sample take the demo was measured on: the
 * flat runs are where the four silences are, and `SILENCES` names the same
 * stretches so the marks and the bars cannot drift apart.
 */
const WAVE = [
  9, 14, 22, 17, 26, 11, 24, 19, 28, 15, 21, 1, 1, 1, 1, 1, 12, 25, 18, 27,
  13, 23, 16, 29, 20, 1, 1, 1, 1, 10, 24, 18, 26, 14, 22, 17, 1, 1, 1, 1,
  1, 1, 21, 27, 12, 25, 16, 23, 19, 28, 1, 1, 1, 15, 26, 20, 24, 13, 22, 18,
];
/** [from, to) in bar indices, matching the flat runs above exactly. */
const SILENCES: Array<[number, number]> = [
  [11, 16],
  [25, 29],
  [36, 42],
  [50, 53],
];

const WAVE_BARS = Array.from({ length: 48 }, (_, i) => ({
  height: 20 + Math.sin(i * 0.6) * 35 + Math.random() * 30,
  dur: 0.5 + Math.random() * 0.8,
  delay: (i * 0.04) % 1,
}));

/**
 * The ladder, at module scope so nothing on this page can compare against a
 * plan before the plan has been read. See `planKnown` below.
 */
const RANK = { free: 0, creator: 1, pro: 2, studio: 3 } as const;

/**
 * The editor, drawn.
 *
 * What was here was a screen recording: `tools/demo-capture.mjs` driving the
 * built app through one real edit. The reasoning was sound and the result was
 * not, for three reasons that no amount of re-recording fixes.
 *
 * The largest element in that recording is the video player, and the demo
 * project has no footage in it — so the biggest thing on a page selling a
 * video editor was an empty purple gradient where the video goes. A 1280x800
 * browser window scaled into a 1000px hero renders every label at about eight
 * pixels, which is a picture of text rather than text. And it was encoded at
 * 209kbps, so what little was legible was also blocky, and it cost 1.4MB
 * across four files that every visitor downloaded.
 *
 * This is the same screen, drawn at the size it is shown: real DOM and real
 * type, so it is sharp at any density and on any screen, with the drawn parts
 * — the frame, the waveform, the crop — as inline SVG. Nothing is downloaded.
 * Nothing goes stale when a button in the app moves, because it is not a
 * photograph of the app; it is the claim the page is making, which is that you
 * say a sentence and get an edit back.
 *
 * Every number on it is real: 12.3s in and 6.5s out is what
 * `tools/demo-capture.mjs` measured on the sample take, and the operations
 * listed are the ones that plan actually produces.
 */
function HeroEditor({ phone, language }: { phone: boolean; language: Language }) {
  const t = (phrase: Phrase) => say(phrase, language);
  const copy = LANDING.heroEditor;
  return (
    // `text-start` because the hero section around this is centred, and an app
    // whose every label is centred does not read as an app. Logical rather than
    // `text-left`: this is a drawing of the product, and the product is set the
    // way the language reads.
    <div className="force-dark text-start rounded-xl overflow-hidden relative bg-[#0a090b] text-[#efeaf7]">
      {/* Title bar */}
      <div className="flex items-center gap-3 px-4 sm:px-5 h-12 sm:h-14 border-b border-white/[0.07] bg-white/[0.02]">
        <ChevronLeft className="w-4 h-4 text-white/35 flex-shrink-0" />
        <p className="text-[13px] sm:text-[15px] font-semibold truncate">{t(copy.projectTitle)}</p>
        <span className="hidden sm:inline-flex text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-400/15 text-emerald-300 border border-emerald-400/25 flex-shrink-0">
          {t(copy.status)}
        </span>
        <div className="ms-auto flex items-center gap-2 flex-shrink-0">
          <span className="hidden sm:flex items-center gap-1.5 text-[13px] text-white/60 px-3 py-1.5 rounded-lg border border-white/10">
            <Download className="w-3.5 h-3.5" /> {t(copy.exportLabel)}
          </span>
          <span className="flex items-center gap-1.5 text-[12px] sm:text-[13px] font-semibold text-white px-3 py-1.5 rounded-lg bg-[#50a1ed] shadow-[0_0_20px_rgba(80,161,237,0.45)]">
            <Sparkles className="w-3.5 h-3.5" /> {t(copy.generate)}
          </span>
        </div>
      </div>

      <div className="grid md:grid-cols-[minmax(0,0.92fr)_minmax(0,1fr)]">
        {/* ── What went in ── */}
        <div className="p-4 sm:p-5 md:border-r border-white/[0.07] flex flex-col gap-3">
          <p className="text-[12px] sm:text-[11px] uppercase tracking-[0.14em] text-white/35 font-semibold">
            {t(copy.rawTake)}
          </p>

          {/* The frame. A speaker sitting off to one side, which is what a
              phone on a desk actually films, and what the reframe below is
              for. */}
          <div className="rounded-lg overflow-hidden border border-white/10 relative">
            {/* Filled, not outlined, and lit from one side.
                An outline drawing of a person reads as an icon — which is what
                the recording this replaced had in its video pane, and why that
                pane read as empty. Shapes with mass, a lamp behind them and a
                line where the wall meets the desk read as a frame somebody
                filmed. The subject sits right of centre because that is where a
                phone propped on a desk puts you, and it is what the 9:16 crop
                further down is correcting. */}
            <svg viewBox="0 0 320 180" className="w-full h-auto block" aria-hidden="true">
              <defs>
                <linearGradient id="hero-room" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#1b3146" />
                  <stop offset="0.58" stopColor="#112232" />
                  <stop offset="1" stopColor="#0c151d" />
                </linearGradient>
                <radialGradient id="hero-lamp" cx="0.64" cy="0.3" r="0.55">
                  <stop offset="0" stopColor="#50a1ed" stopOpacity="0.5" />
                  <stop offset="1" stopColor="#50a1ed" stopOpacity="0" />
                </radialGradient>
                <radialGradient id="hero-vignette" cx="0.5" cy="0.45" r="0.78">
                  <stop offset="0.45" stopColor="#000" stopOpacity="0" />
                  <stop offset="1" stopColor="#000" stopOpacity="0.42" />
                </radialGradient>
              </defs>
              <rect width="320" height="180" fill="url(#hero-room)" />
              <rect width="320" height="180" fill="url(#hero-lamp)" />
              {/* Where the wall meets the desk. */}
              <path d="M0 132h320" className="stroke-white" strokeOpacity="0.06" strokeWidth="2" />
              {/* The speaker. An ellipse rather than a circle, shoulders that
                  are not symmetrical, and a rim light down the side the lamp is
                  on: three details that are the difference between a figure in
                  a frame and the avatar glyph every placeholder uses. */}
              <g className="fill-[#c7dff5]" opacity="0.62">
                {/* Neck first, then shoulders over it, then the head over both,
                    so the three read as one body. Drawn as separate shapes with
                    a gap between them, this was a head floating above a hill. */}
                <rect x="194" y="84" width="18" height="24" rx="7" />
                <path d="M166 152c0-30 16-50 37-50s37 20 37 50z" />
                <ellipse cx="203" cy="70" rx="21" ry="23" />
              </g>
              {/* A rim light down the side the lamp is on. */}
              <path
                d="M220 55a21 23 0 0 1 3 28"
                className="fill-none stroke-[#efe8ff]"
                strokeOpacity="0.55"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
              {/* A vignette, because a lens has one. */}
              <rect width="320" height="180" fill="url(#hero-vignette)" />
            </svg>
            <div className="absolute bottom-2 start-2 text-[12px] sm:text-[10px] font-mono text-white/45 bg-black/45 px-1.5 py-0.5 rounded" dir="ltr">
              1920×1080 · 12.3s
            </div>
          </div>

          {/* The timeline, with the dead air marked rather than described. */}
          <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
            <svg viewBox="0 0 300 46" className="w-full h-auto" aria-hidden="true">
              {WAVE.map((h, i) => (
                <rect
                  key={i}
                  x={i * 5}
                  y={23 - h}
                  width="2.6"
                  height={h * 2}
                  rx="1.3"
                  className={h > 2 ? "fill-[#50a1ed]" : "fill-white/15"}
                />
              ))}
              {/* Where the silences are, and that they are going. */}
              {SILENCES.map(([from, to], i) => (
                <g key={i}>
                  <rect x={from * 5} y="0" width={(to - from) * 5} height="46" rx="3" className="fill-white/[0.06]" />
                  <path
                    d={`M${from * 5 + 1} 40h${(to - from) * 5 - 2}`}
                    className="stroke-white/30"
                    strokeWidth="1.5"
                    strokeDasharray="3 3"
                    strokeLinecap="round"
                  />
                </g>
              ))}
            </svg>
            <p className="mt-2 text-[12px] text-white/45">
              {t(copy.silencesLead)} <span className="text-white/70">{t(copy.deadAirAmount)}</span>{" "}
              {t(copy.silencesTail)}
            </p>
          </div>
        </div>

        {/* ── What was asked, and what came back ── */}
        <div className="p-4 sm:p-5 flex flex-col gap-3">
          <div className="flex justify-end">
            <p className="max-w-[85%] text-[12px] sm:text-[13.5px] leading-relaxed rounded-2xl rounded-ee-sm px-3.5 py-2.5 bg-[#50a1ed] text-white">
              {t(copy.ask)}
            </p>
          </div>

          <div className="flex items-start gap-2.5">
            <span className="w-7 h-7 rounded-full bg-[#50a1ed]/25 border border-[#50a1ed]/40 flex items-center justify-center flex-shrink-0">
              <Sparkles className="w-3.5 h-3.5 text-[#79b7f1]" />
            </span>
            <div className="min-w-0">
              <p className="text-[12px] sm:text-[11px] font-semibold text-white/50 mb-1.5">{t(copy.assistant)}</p>
              <p className="text-[12px] sm:text-[13.5px] leading-relaxed text-white/80 mb-2.5">
                {t(copy.intro)}
              </p>
              {/* The plan, itemised. This is the promise the product makes:
                  you see the edit described before it is rendered. */}
              <ul className="flex flex-col gap-1.5">
                {[copy.planCutSilence, copy.planReframe, copy.planCaptions, copy.planLevel]
                  .map(t)
                  .map((line) => (
                    <li key={line} className="flex items-start gap-2 text-[12px] sm:text-[13px] leading-snug text-white/70">
                      <Check className="w-3.5 h-3.5 text-emerald-400 mt-0.5 flex-shrink-0" />
                      {line}
                    </li>
                  ))}
              </ul>
            </div>
          </div>

          {/* What came out, beside the numbers that describe it. */}
          <div className="mt-1 flex items-stretch gap-3 rounded-xl border border-[#50a1ed]/30 bg-[#50a1ed]/[0.07] p-3">
            <div className="w-[62px] sm:w-[72px] flex-shrink-0 rounded-md overflow-hidden border-2 border-[#50a1ed]/60">
              {/* The same room, cropped to 9:16 and centred on the speaker,
                  with the captions on the picture rather than beside it. */}
              <svg viewBox="0 0 62 110" className="w-full h-auto block" aria-hidden="true">
                <rect width="62" height="110" fill="url(#hero-room)" />
                <rect width="62" height="110" fill="url(#hero-lamp)" />
                <g className="fill-[#c7dff5]" opacity="0.68">
                  <rect x="26" y="46" width="10" height="14" rx="4" />
                  <path d="M9 84c0-17 10-28 22-28s22 11 22 28z" />
                  <ellipse cx="31" cy="38" rx="13" ry="15" />
                </g>
                <rect x="11" y="88" width="40" height="6" rx="3" className="fill-white" opacity="0.92" />
                <rect x="20" y="98" width="22" height="6" rx="3" className="fill-white" opacity="0.92" />
              </svg>
            </div>
            <div className="min-w-0 flex flex-col justify-center gap-1">
              <p className="text-[12px] sm:text-[13.5px] font-semibold text-white">
                {t(copy.resultTitle)}
              </p>
              <p className="text-[12px] leading-snug text-white/55">
                {t(copy.resultDetail)}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The horizon: the lit edge where a dark band meets the page above it.
 *
 * ## The shape is not an arc
 *
 * The first version drew it as a very wide ellipse, because an ellipse is one
 * `border-radius` and needs no geometry. It is also the wrong shape, and Osama
 * said so twice before it was measured properly: on the reference the edge is
 * **flat at both ends** and rises only through the middle. An ellipse has slope
 * everywhere — its ends are the steepest part of it — so however wide it is
 * made, the far left and far right of the page tilt, and the whole thing reads
 * as a circle laid over the page rather than as a horizon.
 *
 * What the reference actually is, is a bell: horizontal tangents at both ends
 * and at the apex. That is exactly one cubic bezier per half with its control
 * points held level with the point they leave — `C x1,S x2,y0 apex,y0` out of
 * `0,S`, and the mirror of it back down to `1000,S`. Two curves, four numbers,
 * and the ends are *mathematically* flat rather than nearly flat.
 *
 * The apex sits at 46% of the width rather than 50%. A perfectly symmetrical
 * bump is a shape; the reference's leans, with a longer tail on one side, and
 * that is the difference between a horizon and a semicircle.
 *
 * ## The light is a set of strokes, clipped to the dark side
 *
 * Six copies of the same path, from a 150-unit blurred stroke at the bottom to
 * a 9-unit near-white one on top, all clipped to the region *below* the curve.
 * A stroke is centred on its path, so half of each falls inside the dark and
 * the visible band is a plateau of light at the edge with a ramp under it —
 * the profile measured off the reference, where the first forty-odd pixels
 * stay bright and only then fall away.
 *
 * Nothing is painted outside the shape. Any outer glow, however small, hazes
 * the section above and turns the arc into a dark object with something lit
 * behind it; on the reference the page above runs clean right up to the light.
 * All six `<use>` elements reference one `<path>`, so the swell below is two
 * `setAttribute` calls per frame rather than twelve.
 *
 * ## The swell
 *
 * The apex height is a half-sine of how far the band has travelled into the
 * viewport: shallow as it appears, deepest as it crosses the middle of the
 * screen, shallow again as it leaves. `--arc-lit` rides the same curve so the
 * light brightens with it. It is a rAF loop over two attributes and one custom
 * property, and React is never told — a component tree re-rendered per frame to
 * move a gradient is how a landing page becomes the slowest screen in a
 * product. With `prefers-reduced-motion` it is drawn once and left alone.
 */

/**
 * The box the curve is drawn in, and its units are **pixels**.
 *
 * The first version gave the `<svg>` a fixed 1000-unit viewBox and let
 * `preserveAspectRatio="none"` stretch it to the page. That is fine at 1440,
 * where the horizontal scale is 1.44 and the vertical is 1, and it is ruinous
 * at 390, where the horizontal scale is 0.39 and the vertical is still 1.
 *
 * A stroke is thick perpendicular to its path, so under a non-uniform scale its
 * apparent thickness depends on the direction the path is going: squeezed to a
 * third of the width, the bell's shoulders become nearly vertical, and a
 * 150-unit stroke that reads as a soft 150px band across a laptop reads as a
 * pair of fat concentric arcs stacked in the corners of a phone. That is
 * exactly what it looked like. The blur went the same way.
 *
 * So the viewBox is set from the element's own width and the path is built in
 * real pixels: the mapping is 1:1 on both axes at every size, and a stroke is
 * the thickness it says it is. The bell's control points are fractions of the
 * width, so its *proportions* are the same everywhere — which is what
 * `preserveAspectRatio` was being asked for and could not give without
 * distorting everything else.
 */
const HORIZON_BOX = 380;
/** Where the flat ends sit inside that box — the band's own top edge. */
const HORIZON_SHOULDER = 250;
/** Apex height at rest, and how much more it gains crossing the screen. */
const HORIZON_REST = 76;
const HORIZON_SWELL = 42;
/**
 * How the apex scales with the page.
 *
 * A 100px bell across 1440px is a horizon. The same 100px across 390px is a
 * hill, and its shoulders are steep enough to read as a shape rather than as
 * light on an edge. The apex is proportional to the width, clamped so it never
 * disappears on a narrow phone and never becomes a dome on a wide monitor.
 */
const HORIZON_REFERENCE_WIDTH = 1440;
const horizonScale = (width: number) =>
  Math.max(0.42, Math.min(1.1, width / HORIZON_REFERENCE_WIDTH));

/**
 * The band, widest and dimmest first, because a `<g>` paints in document order
 * and the narrow bright ones belong on top.
 */
const HORIZON_LAYERS = [
  { w: 150, blur: 34, colour: "rgba(10, 105, 194, 0.8)" },
  { w: 104, blur: 24, colour: "rgba(80, 161, 237, 0.95)" },
  { w: 72, blur: 16, colour: "rgb(112, 178, 240)" },
  { w: 46, blur: 10, colour: "rgb(163, 205, 245)" },
  { w: 26, blur: 6, colour: "rgb(213, 233, 251)" },
];

/*
 * The lip, and it is the one layer that is *not* clipped.
 *
 * Clipping antialiases, and six clipped layers stacked leave a one-pixel seam
 * along the curve — measured at 222,207,253 against a 251,249,253 page, which
 * is faint and is unmistakably a drawn line once you have seen it. Painting the
 * brightest, narrowest stroke over the top of the clip covers that seam with
 * light instead of hiding it. It spills about five pixels above the curve; at
 * this colour, on a page this light, that is invisible, and on the dark side it
 * is the bright edge the whole band is built around.
 */
const HORIZON_LIP = { w: 18, blur: 6, colour: "rgb(250, 253, 254)" };

/**
 * The bell, in pixels, for a page `width` wide.
 *
 * Every horizontal number is a fraction of the width, so the curve keeps its
 * shape at any size. The control points sit level with the point they leave —
 * `C x1,S x2,y0 apex,y0` out of `0,S` — which is what makes both ends
 * mathematically flat rather than nearly flat. The apex is at 46% of the
 * width, not 50%: a symmetrical bump is a shape, and the reference leans.
 */
function horizonPath(width: number, apex: number) {
  const s = HORIZON_SHOULDER;
  const y = s - apex;
  const ax = width * 0.46;
  const tail = width - ax;
  return (
    `M0 ${s} C ${(width * 0.25).toFixed(1)} ${s} ${(width * 0.24).toFixed(1)} ${y} ${ax.toFixed(1)} ${y}` +
    ` C ${(ax + tail * 0.48).toFixed(1)} ${y} ${(ax + tail * 0.46).toFixed(1)} ${s} ${width} ${s}`
  );
}

/**
 * One lit edge, and the dark it belongs to.
 *
 * `foot` flips it: the same curve upside down at the bottom of the band, at a
 * third of the light, so the dark closes rather than stopping on a ruled line.
 */
function Horizon({ foot = false }: { foot?: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const edgeRef = useRef<SVGPathElement>(null);
  const capRef = useRef<SVGPathElement>(null);
  const groundRef = useRef<SVGRectElement>(null);
  const id = foot ? "horizon-foot" : "horizon-head";

  useEffect(() => {
    const box = boxRef.current;
    const edge = edgeRef.current;
    const cap = capRef.current;
    const ground = groundRef.current;
    if (!box || !edge || !cap) return;
    const section = box.parentElement;
    if (!section) return;

    const svg = box.querySelector("svg");
    let width = 0;

    const draw = (apex: number) => {
      const d = horizonPath(width, apex);
      edge.setAttribute("d", d);
      cap.setAttribute("d", `${d} L${width} ${HORIZON_BOX} L0 ${HORIZON_BOX} Z`);
    };

    /*
     * One `viewBox` per resize, never per frame — it is the only thing here
     * that depends on the width rather than on the scroll.
     *
     * The band's thickness travels with it. Now that the strokes are in real
     * pixels they no longer shrink on their own, and a 150px band across a
     * 390px phone is a quarter of the screen: on a laptop the same band is a
     * horizon, on a phone it is a stripe. Every layer is scaled by the same
     * factor as the apex, so the whole thing keeps its proportions instead of
     * only its shape. The lip scales less — it is a specular edge, and an edge
     * that thins with the screen stops reading as light.
     */
    const fit = () => {
      const next = Math.max(1, Math.round(box.getBoundingClientRect().width));
      if (next === width) return;
      width = next;
      const k = horizonScale(width);
      svg?.setAttribute("viewBox", `0 0 ${width} ${HORIZON_BOX}`);
      ground?.setAttribute("width", String(width + 80));
      box.querySelectorAll<SVGUseElement>("[data-stroke]").forEach((layer) => {
        const base = Number(layer.dataset.stroke);
        const scale = layer.dataset.lip ? 0.62 + 0.38 * k : k;
        layer.setAttribute("stroke-width", (base * scale).toFixed(1));
      });
      /* The filter region is in user space, so it has to grow with the page —
         see the note in the markup. 400px of margin on each side is more than
         the widest blur here can reach. */
      box.querySelectorAll<SVGElement>("[data-region]").forEach((f) => {
        f.setAttribute("width", String(width + 800));
      });
      box.querySelectorAll<SVGElement>("feGaussianBlur[data-stroke]").forEach((fe) => {
        const blur = Number(fe.dataset.blur);
        const scale = fe.dataset.lip ? 0.62 + 0.38 * k : k;
        /* `stdDeviation` is half a CSS blur radius: `blur(20px)` and
           `stdDeviation="10"` are the same Gaussian. */
        fe.setAttribute("stdDeviation", ((blur * scale) / 2).toFixed(2));
      });
    };

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still) {
      fit();
      draw((HORIZON_REST + HORIZON_SWELL * 0.7) * horizonScale(width));
      box.style.setProperty("--arc-lit", "1");
      return;
    }

    let frame = 0;
    let shown = -1;
    let target = 0;
    let lit = 0;

    const measure = () => {
      const rect = section.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      /* 0 the moment the band's edge reaches the bottom of the screen, 1 by
         the time it has climbed nine tenths of the way up. Clamped at both
         ends, so a band that is far off or long gone sits still. */
      const from = foot ? rect.bottom : rect.top;
      const p = Math.max(0, Math.min(1, (vh - from) / (vh * 0.9)));
      const swell = Math.sin(Math.PI * p);
      target = (HORIZON_REST + HORIZON_SWELL * swell) * horizonScale(width);
      lit = (foot ? 0.2 : 0.45) + (foot ? 0.22 : 0.55) * swell;
    };

    const tick = () => {
      frame = 0;
      if (shown < 0) shown = target;
      else shown += (target - shown) * 0.14;
      draw(shown);
      box.style.setProperty("--arc-lit", lit.toFixed(3));
      /* Six blurred strokes are not a free repaint, so the loop settles at
         well under a pixel of remaining movement rather than at a tenth. */
      if (Math.abs(target - shown) > 0.6) frame = requestAnimationFrame(tick);
    };

    const onScroll = () => {
      measure();
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const onResize = () => {
      fit();
      onScroll();
    };

    fit();
    measure();
    shown = target;
    tick();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    /*
     * A resize event is not the only way this box changes width, and the one it
     * misses is the common one: a classic scrollbar appearing once the page has
     * laid out takes the element from 447 to 431 with no window resize at all.
     * The viewBox then disagreed with the element by those 16px, and
     * `xMidYMid meet` — which is here so the mapping stays 1:1, see the note on
     * the units above — answered by centring the drawing and leaving 8px of
     * bare section down each side. On a phone that is a notch out of the light
     * at both ends of the wave. Watching the element itself catches every cause
     * rather than the one that happens to fire an event.
     */
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
    ro?.observe(box);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [foot]);

  return (
    <div ref={boxRef} className={foot ? "horizon horizon-at-foot" : "horizon"} aria-hidden="true">
      <svg
        className="horizon-svg"
        viewBox={`0 0 1000 ${HORIZON_BOX}`}
        preserveAspectRatio="xMidYMid meet"
        focusable="false"
      >
        <defs>
          <path id={`${id}-edge`} ref={edgeRef} d="" />
          <clipPath id={`${id}-under`}>
            <path ref={capRef} d="" />
          </clipPath>
          {/*
            An SVG filter, not `filter: blur()` in CSS, and this is the whole
            reason the arc was wrong on a phone.

            A CSS filter on an element *inside* an `<svg>` — a `<use>`, a
            `<path>` — is a long-standing WebKit weak spot, and Safari on iOS
            simply did not apply these. Without the blur every stroke keeps its
            own hard edge, so the six layers that are meant to melt into one
            band of light rendered as six concentric arcs stacked in the
            corners of the screen. It was right in Chromium and wrong on the
            phone Osama was holding, which is the worst way for a thing to be
            wrong. `<feGaussianBlur>` is SVG's own and works everywhere.

            `stdDeviation` is half a CSS blur radius. `color-interpolation-
            filters="sRGB"` is not optional either: SVG filters default to
            linearRGB, which lightens a blurred gradient noticeably, and every
            colour here was picked against the sRGB blur CSS gave.

            The region is in **user space**, not in bounding-box percentages,
            and that is the second half of the same bug. A percentage region is
            resolved against the bounding box of the filtered element, and for a
            `<use>` that box is whatever the browser has decided the referenced
            path measures — which on iOS came out short, so the band was blurred
            for the left two thirds of the page and simply stopped. Osama
            photographed a wave that ran out two thirds of the way across.

            Absolute numbers cannot be got wrong: the region is the whole box
            plus 400px of margin on every side, and `fit()` widens it with the
            page. Nothing about it depends on a measurement.
          */}
          {[...HORIZON_LAYERS, HORIZON_LIP].map((layer) => (
            <filter
              key={layer.w}
              id={`${id}-soft-${layer.w}`}
              data-region=""
              filterUnits="userSpaceOnUse"
              x="-400"
              y="-400"
              width="2400"
              height={HORIZON_BOX + 800}
              colorInterpolationFilters="sRGB"
            >
              <feGaussianBlur
                data-stroke={layer.w}
                data-blur={layer.blur}
                {...(layer === HORIZON_LIP ? { "data-lip": "1" } : {})}
                stdDeviation={layer.blur / 2}
              />
            </filter>
          ))}
        </defs>
        <g clipPath={`url(#${id}-under)`}>
          {/* The dark itself, so the curve is the boundary rather than a line
              drawn near one. Oversized, because a blurred stroke at the edge of
              the box would otherwise show the box. */}
          <rect ref={groundRef} x="-40" y="-40" width="1080" height={HORIZON_BOX + 80} fill="hsl(var(--background))" />
          {HORIZON_LAYERS.map((layer) => (
            <use
              key={layer.w}
              href={`#${id}-edge`}
              fill="none"
              stroke={layer.colour}
              strokeWidth={layer.w}
              strokeLinecap="butt"
              data-stroke={layer.w}
              filter={`url(#${id}-soft-${layer.w})`}
              style={{ opacity: "var(--arc-lit, 1)" }}
            />
          ))}
        </g>
        <use
          href={`#${id}-edge`}
          fill="none"
          stroke={HORIZON_LIP.colour}
          strokeWidth={HORIZON_LIP.w}
          strokeLinecap="butt"
          data-stroke={HORIZON_LIP.w}
          data-lip="1"
          /* Fully opaque, unlike every layer inside the clip. It is covering an
             antialiasing seam, and a half-transparent cover leaves half a seam;
             the swell dims the band under it, not the line that hides the join. */
          filter={`url(#${id}-soft-${HORIZON_LIP.w})`}
        />
      </svg>
    </div>
  );
}

/**
 * How it works, as one continuous movement rather than three cards.
 *
 * Three cards side by side is a *list*, and a list says the three things are
 * alternatives. These are not alternatives — they are one thing after another,
 * and the page should be unable to show you the second before it has shown you
 * the first. So the section is built as a track you move along: the picture
 * holds still on the left while the writing goes past it on the right, one step
 * at a time, and a line down the margin fills in as you go so you can see how
 * far through the sequence you are without counting.
 *
 * ## The three pieces, and what each one is doing
 *
 * **The picture is pinned, not repeated.** One frame in one place, holding
 * whatever the current step looks like, cross-fading between them. That is what
 * makes the sequence read as a sequence rather than as three unrelated
 * illustrations: the eye never has to go and find the next picture, because the
 * picture is always in the same place and it is the *content* that changes.
 *
 * **The writing dims when it is not its turn.** Everything is on the page at
 * once — you can read ahead, and a search engine and a screen reader get the
 * whole thing in order — but only one step is at full contrast. Contrast is the
 * cheapest way to say "this one", and it costs no layout.
 *
 * **The line fills to a fixed point on the screen.** Its bottom edge sits at
 * 46% of the viewport height and stays there; the *section* moves past it. So
 * the fill is not an animation that plays, it is a measurement of where you
 * are, and it cannot get out of step with the page.
 *
 * ## Why it is smoothed, and why by hand
 *
 * The fill follows the scroll position through a critically-damped lerp rather
 * than tracking it exactly. Exact tracking is correct and feels mechanical: on
 * a trackpad, where the scroll position arrives in jerks, an exactly-tracking
 * line jerks with it. Lagging about a tenth of the distance per frame turns the
 * same input into one continuous slide, and the lag is small enough that it
 * still reads as *the scroll* rather than as a thing moving on its own.
 *
 * It is a rAF loop over one `style.height` rather than React state, because
 * this value changes on every frame of a scroll and rendering a component tree
 * sixty times a second to move a line is how a landing page becomes the slowest
 * screen in a product. React hears only about the *step*, which changes a few
 * times per section.
 *
 * `prefers-reduced-motion` turns the smoothing off — the line still marks the
 * position, it just gets there without the glide.
 */

/** Where on the screen "now" is. Measured off the reference: 46% down. */
const PLAYHEAD = 0.46;
/**
 * And where it is when the picture is *above* the writing rather than beside it.
 *
 * On a phone the pinned frame takes the top half of the screen, so a playhead
 * at 46% sits behind it: the step that is lit would be the one hidden under the
 * picture, and the line would fill to a point nobody can see. Three quarters
 * down puts it in the middle of what is actually readable.
 */
const PLAYHEAD_STACKED = 0.76;
/** The width at which the two columns appear — Tailwind's `lg`. */
const TWO_COLUMNS = "(min-width: 1024px)";
/** How much of the remaining distance the fill closes each frame. */
const RAIL_SMOOTHING = 0.12;

function HowItWorks({ t, rtl }: { t: (phrase: Phrase) => string; rtl: boolean }) {
  const railRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const stepRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const rail = railRef.current;
    const fill = fillRef.current;
    if (!rail || !fill) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let frame = 0;
    let shown = -1;
    let target = 0;

    const measure = () => {
      const rect = rail.getBoundingClientRect();
      const wide = window.matchMedia(TWO_COLUMNS).matches;
      const playhead = window.innerHeight * (wide ? PLAYHEAD : PLAYHEAD_STACKED);
      target = Math.max(0, Math.min(rect.height, playhead - rect.top));
      /* The active step is the last one whose top has crossed the playhead —
         `last`, not `first`, so that scrolling back up hands the title back to
         the step above instead of leaving the final one lit for ever. */
      let next = 0;
      for (let i = 0; i < stepRefs.current.length; i += 1) {
        const el = stepRefs.current[i];
        if (el && el.getBoundingClientRect().top <= playhead) next = i;
      }
      setActive(next);
    };

    const tick = () => {
      frame = 0;
      if (shown < 0 || still) shown = target;
      else shown += (target - shown) * RAIL_SMOOTHING;
      fill.style.height = `${shown}px`;
      if (Math.abs(target - shown) > 0.4) frame = requestAnimationFrame(tick);
    };

    const onScroll = () => {
      measure();
      if (!frame) frame = requestAnimationFrame(tick);
    };

    measure();
    shown = target;
    tick();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  /*
   * Each step is drawn, not screenshotted — the same three drawings that were
   * in the cards, at four times the size, which is the size they were always
   * worth. A picture of a screen you cannot read says only "there is a screen".
   *
   * The wash behind each one stands in for the reference's photograph. It is
   * three radial gradients rather than a stock image on purpose: it weighs
   * nothing, it cannot go stale, it has no licence, and it is the one part of
   * this section that is allowed to be purely decorative because it is
   * *behind* the thing being explained.
   */
  const steps = [
    {
      num: "01",
      title: t(LANDING.steps.one.title),
      desc: t(LANDING.steps.one.desc),
      wash: "radial-gradient(120% 95% at 18% 12%, #b1d2f1 0%, rgba(177, 210, 241,0) 62%), radial-gradient(115% 95% at 88% 84%, #d4e6f7 0%, rgba(212, 230, 247,0) 64%), linear-gradient(146deg, #eff5fb 0%, #ebf3fa 100%)",
      art: (
          <svg viewBox="0 0 320 180" className="w-full h-full" aria-hidden="true">
            <g transform={rtl ? MIRROR : undefined}>
              <rect x="20" y="18" width="280" height="144" rx="12" className="fill-none stroke-[var(--art-line)]" strokeWidth="2" strokeDasharray="8 7" />
              <rect x="44" y="42" width="232" height="96" rx="10" className="fill-[var(--art-base)]" />
              <rect x="44" y="42" width="232" height="96" rx="10" className="fill-none stroke-[var(--art-line)]" strokeWidth="1.5" />
              {/* The take, with the dead air still in it — flat where
                  nobody is talking, which is what step three removes. */}
              {[14, 22, 9, 26, 17, 24, 2, 2, 2, 2, 19, 27, 11, 23, 8, 2, 2, 2, 25, 13, 21, 16, 2, 2, 18, 26, 10, 20].map((h, n) => (
                <rect
                  key={n}
                  x={62 + n * 7}
                  y={106 - h}
                  width="3.5"
                  height={h * 2}
                  rx="1.75"
                  className={h > 3 ? "fill-[var(--art-accent)]" : "fill-[var(--art-line)]"}
                />
              ))}
            </g>
            {/* A file name and a timecode, which are Latin either way:
                `dir` keeps `raw-take.mov` from being reordered when the
                page around it is right-to-left. */}
            <text {...mirrored(62, "start", rtl, 320, true)} y="68" style={{ direction: "ltr" }} className="fill-[var(--art-accent)]" fontSize="13" fontWeight="600" fontFamily="ui-monospace, monospace">{t(LANDING.steps.one.file)}</text>
            <text {...mirrored(258, "end", rtl, 320, true)} y="68" style={{ direction: "ltr" }} className="fill-[var(--art-line)]" fontSize="12" fontFamily="ui-monospace, monospace">{t(LANDING.steps.one.duration)}</text>
          </svg>
      ),
    },
    {
      num: "02",
      title: t(LANDING.steps.two.title),
      desc: t(LANDING.steps.two.desc),
      wash: "radial-gradient(120% 95% at 82% 14%, #98c6f0 0%, rgba(152, 198, 240,0) 60%), radial-gradient(115% 95% at 14% 86%, #c7dff5 0%, rgba(199, 223, 245,0) 64%), linear-gradient(146deg, #ebf3fa 0%, #f3f8fc 100%)",
      art: (
          <svg viewBox="0 0 320 180" className="w-full h-full" aria-hidden="true">
            <g transform={rtl ? MIRROR : undefined}>
              {/* What you typed, */}
              <rect x="78" y="18" width="226" height="48" rx="12" className="fill-[var(--art-accent-soft)]" />
              <rect x="78" y="18" width="226" height="48" rx="12" className="fill-none stroke-[var(--art-accent)]" strokeWidth="1.5" />
              {/* and what it says back, before it starts. The tick is
                  moved rather than mirrored: a reversed check mark is a
                  shape people read as almost-a-tick. */}
              <circle cx="34" cy="98" r="12" className="fill-[var(--art-accent-soft)]" />
              {[
                { y: 84, w: 162 },
                { y: 114, w: 124 },
                { y: 144, w: 158 },
              ].map((row) => (
                <g key={row.y}>
                  <rect x="56" y={row.y} width={row.w} height="28" rx="14" className="fill-[var(--art-base)]" />
                  <rect x="56" y={row.y} width={row.w} height="28" rx="14" className="fill-none stroke-[var(--art-line)]" strokeWidth="1.5" />
                </g>
              ))}
            </g>
            <path
              d="M28 98l4.5 4.5L40 94"
              transform={rtl ? "translate(252,0)" : undefined}
              className="fill-none stroke-[var(--art-accent)]"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <text {...mirrored(94, "start", rtl)} y="39" className="fill-[var(--art-accent)]" fontSize="11.5" fontWeight="600">{t(LANDING.steps.two.askLine1)}</text>
            <text {...mirrored(94, "start", rtl)} y="56" className="fill-[var(--art-accent)]" fontSize="11.5" fontWeight="600">{t(LANDING.steps.two.askLine2)}</text>
            {[
              { y: 84, label: LANDING.steps.two.planSilence },
              { y: 114, label: LANDING.steps.two.planReframe },
              { y: 144, label: LANDING.steps.two.planCaptions },
            ].map((row) => (
              <text key={row.y} {...mirrored(72, "start", rtl)} y={row.y + 19} className="fill-[var(--art-accent)]" fontSize="11.5">
                {t(row.label)}
              </text>
            ))}
          </svg>
      ),
    },
    {
      num: "03",
      title: t(LANDING.steps.three.title),
      desc: t(LANDING.steps.three.desc),
      wash: "radial-gradient(125% 95% at 50% 8%, #b8d7f5 0%, rgba(184, 215, 245,0) 58%), radial-gradient(115% 95% at 12% 92%, #79b7f1 0%, rgba(121, 183, 241,0) 62%), linear-gradient(146deg, #eff5fb 0%, #e7f0f9 100%)",
      art: (
          <svg viewBox="0 0 320 180" className="w-full h-full" aria-hidden="true">
            <g transform={rtl ? MIRROR : undefined}>
              {/* The widescreen you shot, with the speaker sitting off
                to one side of it the way a phone on a desk films you, */}
              <rect x="22" y="34" width="184" height="104" rx="8" className="fill-[var(--art-base)]" />
              <rect x="22" y="34" width="184" height="104" rx="8" className="fill-none stroke-[var(--art-line)]" strokeWidth="1.5" strokeDasharray="6 5" />
              <circle cx="138" cy="74" r="17" className="fill-none stroke-[var(--art-line)]" strokeWidth="2" />
              <path d="M120 116a18 18 0 0 1 36 0" className="fill-none stroke-[var(--art-line)]" strokeWidth="2" />
              {/* and the vertical it kept, centred on them, with the
                words burned onto it. */}
              <rect x="104" y="16" width="94" height="148" rx="10" className="fill-[var(--art-accent-soft)]" />
              <rect x="104" y="16" width="94" height="148" rx="10" className="fill-none stroke-[var(--art-accent)]" strokeWidth="2.5" />
              <circle cx="151" cy="66" r="19" className="fill-none stroke-[var(--art-accent)]" strokeWidth="2.5" />
              <path d="M131 112a20 20 0 0 1 40 0" className="fill-none stroke-[var(--art-accent)]" strokeWidth="2.5" />
              <path d="M126 132h50M138 146h26" className="stroke-[var(--art-accent)]" strokeWidth="7" strokeLinecap="round" />
              <path d="M216 100h30" className="stroke-[var(--art-accent)]" strokeWidth="2" strokeLinecap="round" />
            </g>
            <text {...mirrored(22, "start", rtl)} y="158" className="fill-[var(--art-line)]" fontSize="11" fontFamily="ui-monospace, monospace">{t(LANDING.steps.three.source)}</text>
            <text {...mirrored(216, "start", rtl, 320, true)} y="90" style={{ direction: "ltr" }} className="fill-[var(--art-accent)]" fontSize="12" fontWeight="700" fontFamily="ui-monospace, monospace">{t(LANDING.steps.three.output)}</text>
          </svg>
      ),
    },
  ];

  /* The frame the drawings live in. Pinned on wide screens, and repeated above
     each step on a phone, where there is no room beside the writing for a
     picture to stand still in.

     `light` on the panel is deliberate and is the same trick `.force-dark`
     plays in the hero, run the other way: this is a picture *of* an interface,
     and an interface drawn in the dark theme's ink on a pale wash would be a
     white drawing on white paper. Pinning the tokens makes the drawing read
     the same in both themes, which is what a photograph would do. */
  const frame = (step: (typeof steps)[number], key: string) => (
    <div
      key={key}
      className="absolute inset-0 flex items-center justify-center p-6 sm:p-10 transition-opacity duration-[650ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
      style={{ background: step.wash, opacity: active === Number(step.num) - 1 ? 1 : 0 }}
      aria-hidden={active !== Number(step.num) - 1}
    >
      <div className="light w-full rounded-2xl bg-white/92 backdrop-blur-[2px] p-4 sm:p-6 shadow-[0_28px_70px_-34px_rgba(20,10,60,0.65)] ring-1 ring-black/5">
        <div className="w-full aspect-[16/9]">{step.art}</div>
      </div>
    </div>
  );

  /*
   * No `overflow-hidden` on this section, and that is load-bearing.
   *
   * An ancestor with any overflow other than `visible` becomes the scroll
   * container for a `position: sticky` descendant — and this section does not
   * scroll internally, so the pinned picture inside it would never pin. It
   * would simply scroll away with the page, which is exactly what it did the
   * first time this was built. The wash below is `inset-0` on a relatively
   * positioned box and cannot spill, so there was nothing to clip anyway.
   */
  return (
    <section id="how-it-works" className="w-full bg-band py-24 sm:py-32 relative">
      {/* Hidden where the pinned frame carries a ground of its own: the sticky
            wrapper paints `--band` over whatever is behind it, and over a wash
            that means a faint rectangle with a visible edge follows the frame
            down the page. At 390px the wash is two per cent of violet at the
            top of a section nobody sees the top of. */}
        <div className="hidden lg:block absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(80,161,237,0.08)_0%,transparent_60%)]" />
      <div className="max-w-7xl mx-auto px-6 relative z-10">
        <div className="text-center mb-16 sm:mb-24">
          <div className="reveal">
            <p className="text-primary text-sm font-semibold tracking-widest uppercase mb-3">{t(LANDING.steps.eyebrow)}</p>
            <h2 className="text-4xl md:text-6xl font-bold tracking-tight mb-4">{t(LANDING.steps.title)}</h2>
            <p className="text-muted-foreground text-lg">{t(LANDING.steps.lead)}</p>
          </div>
        </div>

        {/* `items-start` is *not* wanted here, and its absence is the whole
              reason the picture stays put. A sticky element only travels inside
              its own containing block, so if this column shrinks to the height
              of the card there is nothing for the card to be sticky *within*
              and it simply scrolls away. Stretched, the column is as tall as
              the steps beside it, which is exactly the distance the picture
              should hold for. */}
          {/* A grid only at `lg`, and that is what lets the picture pin on a phone.

              Every grid item is its own containing block, so stacked into one
              column the picture's row is exactly as tall as the picture: there
              is nothing for a sticky child to travel inside and it scrolls away
              — measured, `cardTop` walking to −1416 while the steps went past.
              In normal flow the two are siblings of the same block, and that
              block is as tall as the whole sequence. Same defect as
              `items-start` on the two-column version, one row up. */}
          <div className="lg:grid lg:grid-cols-2 lg:gap-20">
          {/*
              The picture, pinned — at every width, and that is the change.

              It used to pin only on a laptop; a phone got a copy of the picture
              above each step and scrolled the lot. That is a different section,
              not a narrower one: the whole idea is that the frame holds still
              and its *contents* change, and repeating the frame three times
              throws that away — you never see one picture become the next,
              which is the only thing the section is doing.

              Stacked, it pins to the top of the screen and the writing goes
              under it. Two things make that work rather than collide: `z-10`,
              because siblings paint in document order and the steps come after,
              so without it the text would ride *over* the frame; and the band's
              own colour on the sticky wrapper, so what passes underneath
              disappears at a clean edge instead of showing through the gap.

              `top-[4.5rem]` clears the collapsed top bar on a phone, `top-28`
              on a laptop where the bar is taller.
          */}
          {/* One element, and it is the sticky one.

              A sticky box travels inside its own containing block, and a
              *wrapper* around it is a block that shrink-wraps to its content —
              which is the picture, so there was nothing to travel in and it
              scrolled away on a phone exactly as it had before. Measured:
              `parentH` 259 against a card 259 tall.

              So the picture's own grid item is sticky. Stacked, its containing
              block is the block that holds the picture *and* the steps, which
              is the whole sequence. In two columns it is the grid area, whose
              height is the row's — and `self-start` is what stops it filling
              that area and leaving itself nowhere to go, which is the same
              trap `items-start` was on the other side of.

              The ground it carries is the band's own colour, and it has to
              cover more than the card: stacked, the strip between the top of
              the screen and the pinned frame is 72px of nothing, and the
              writing scrolled through it in full view. `top-0` with 72px of
              padding puts the frame in the same place and gives the ground the
              whole strip; the negative margin cancels the padding so nothing
              below moves. The `::after` fades the ground out under the card
              rather than ending it on a ruled edge — a hard line there reads as
              a slab laid over the page. */}
          <div className="relative z-10 mb-8 self-start sticky top-0 -mt-[4.5rem] pt-[4.5rem] bg-band after:content-[''] after:absolute after:inset-x-0 after:top-full after:h-8 after:bg-gradient-to-b after:from-band after:to-transparent lg:z-auto lg:mb-0 lg:mt-0 lg:pt-0 lg:top-28 lg:bg-transparent lg:after:hidden">
            <div className="relative w-full aspect-[16/11] lg:aspect-[4/3] overflow-hidden rounded-[28px] ring-1 ring-hairline-faint shadow-[0_40px_90px_-50px_rgba(8,4,24,0.75)]">
              {steps.map((step) => frame(step, step.num))}
            </div>
          </div>

          {/* The writing, and the line down its margin. */}
          <div ref={railRef} className="relative ps-6 sm:ps-10">
            <div className="absolute inset-y-0 start-0 w-px bg-hairline" aria-hidden="true" />
            <div
              ref={fillRef}
              data-testid="steps-progress"
              /* The brand violet, not the action red.
                 Red means "press this" everywhere else in the product, and a
                 red line down the margin of a section with nothing pressable in
                 it spends that meaning on decoration. The reference's line is
                 red because red is the reference's *brand*; ours is #50a1ed. */
              className="absolute start-0 top-0 w-[2px] rounded-full bg-primary"
              style={{ height: 0, boxShadow: "0 0 20px hsl(var(--primary) / 0.6)" }}
              aria-hidden="true"
            />
            {steps.map((step, i) => (
              <div
                key={step.num}
                ref={(el) => {
                  stepRefs.current[i] = el;
                }}
                data-testid={`step-${step.num}`}
                data-active={active === i ? "true" : "false"}
                className="flex flex-col justify-center min-h-[46vh] lg:min-h-[58vh]"
              >
                <p className="font-mono text-xs tracking-[0.35em] text-muted-foreground mb-3">{step.num}</p>
                <h3
                  className={`text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight mb-4 transition-colors duration-500 motion-reduce:transition-none ${
                    active === i ? "text-foreground" : "text-foreground/35"
                  }`}
                >
                  {step.title}
                </h3>
                <p
                  className={`text-base sm:text-lg leading-relaxed max-w-md transition-colors duration-500 motion-reduce:transition-none ${
                    active === i ? "text-muted-foreground" : "text-muted-foreground/40"
                  }`}
                >
                  {step.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const sectionsRef = useScrollReveal();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const subscriptionQuery = useGetSubscription({
    // Only for somebody who has one. `/subscription` is behind `requireAuth`
    // and answers 401 to a visitor, so this fired three times and failed three
    // times on every load of the public page. See `planKnown`.
    query: { queryKey: getGetSubscriptionQueryKey(), enabled: Boolean(user) },
  });
  const { data: subscription } = subscriptionQuery;
  /**
   * Whether we actually know what plan this person is on.
   *
   * `subscription?.plan ?? "free"` was written in three places on this page,
   * and on the one screen where the negative fact costs the customer money.
   * For the few hundred milliseconds before the query resolves — and for the
   * whole of an outage, and for anyone whose token has just rotated — a Pro
   * subscriber saw three cards reading "Get Creator", "Get Pro", "Get Studio"
   * with no Current Plan marker anywhere. Clicking the plan they already pay
   * for opened a Freemius checkout for it, because the downgrade test compares
   * against "free" too.
   *
   * So the page says nothing about somebody's plan until it has been told.
   *
   * ## And a visitor has been told
   *
   * `subscriptionQuery.data !== undefined` was the whole of this, and this is
   * the **public** page. `/subscription` sits behind `requireAuth` and answers
   * 401, so for everybody who is not signed in the query failed, `data` stayed
   * undefined for ever, and all three plan buttons rendered disabled reading
   * "Checking your plan…" — in Arabic, which is what the page opens in,
   * «نقرأ خطّتك…». `handleSelectPlan` returns early on the same flag, so even a
   * programmatic click did nothing.
   *
   * Every pricing button on the marketing site, permanently unpressable, for
   * one hundred per cent of the traffic that has not signed up yet. Nothing
   * threw and nothing was logged: a disabled button with a plausible sentence
   * on it looks like a page that is thinking.
   *
   * A signed-out visitor has no plan, and that is not an unknown — it is
   * known immediately and with certainty. The uncertainty this flag exists for
   * belongs to somebody who *has* an account and whose plan we have not read
   * back yet.
   */
  const planKnown = !user || subscriptionQuery.data !== undefined;
  const currentPlan = (subscription?.plan ?? "free") as keyof typeof RANK;
  const updateSubscription = useUpdateSubscription();
  /** What a downgrade did not do, when it did not do it. See handleSelectPlan. */
  const [billingNotice, setBillingNotice] = useState<{ message: string; where: string } | null>(null);

  const [isYearly, setIsYearly] = useState(false);
  /** Which plan's checkout is opening, so only that button shows a spinner. */
  const [checkoutFor, setCheckoutFor] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  /* ── Parallax refs ─────────────────────────────────────── */
  const heroRef    = useRef<HTMLElement>(null);
  const mockupRef  = useRef<HTMLDivElement>(null);
  const pxTarget   = useRef({ x: 0, y: 0 });
  const pxCurrent  = useRef({ x: 0, y: 0 });
  const rafRef     = useRef<number>(0);

  useEffect(() => {
    const el = heroRef.current;
    if (!el) return;

    const onMouseMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const nx = (e.clientX - rect.left - rect.width  / 2) / (rect.width  / 2);
      const ny = (e.clientY - rect.top  - rect.height / 2) / (rect.height / 2);
      pxTarget.current.x = Math.max(-1, Math.min(1, nx)) * 4;
      pxTarget.current.y = Math.max(-1, Math.min(1, ny)) * 4;
    };

    const tick = () => {
      const t = 0.06;
      pxCurrent.current.x += (pxTarget.current.x - pxCurrent.current.x) * t;
      pxCurrent.current.y += (pxTarget.current.y - pxCurrent.current.y) * t;
      const { x, y } = pxCurrent.current;
      if (mockupRef.current) mockupRef.current.style.translate  = `${x * 0.5}px ${y * 0.5}px`;
      rafRef.current = requestAnimationFrame(tick);
    };

    el.addEventListener("mousemove", onMouseMove);
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      el.removeEventListener("mousemove", onMouseMove);
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  /**
   * Choosing a plan.
   *
   * A downgrade is a request to our own API and takes effect immediately: it
   * only ever reduces what someone is entitled to, so wanting it is proof
   * enough. An upgrade cannot work that way — the API refuses it, and rightly,
   * because being signed in proves who you are and not that you paid. So an
   * upgrade opens Freemius, and the plan changes when the signed webhook
   * arrives, which is the only evidence that exists.
   */
  const handleSelectPlan = async (plan: "creator" | "pro" | "studio") => {
    // Nothing is decided from a plan we have not read. The buttons are disabled
    // until then, so this is belt and braces rather than a live path.
    if (!planKnown) return;
    const current = currentPlan;

    if (RANK[plan] < RANK[current]) {
      /*
        The plan here moves. The card does not, and somebody has to say so.

        Freemius is the merchant of record and nothing in this product can
        cancel a subscription there — so a Pro subscriber pressing this button
        got Creator's allowance immediately and went on being charged for Pro
        until they cancelled it themselves. The button said "Switch to
        Creator", the page then said Creator was their plan, and the only
        place the truth appeared was the card statement a fortnight later.

        The server now returns `billingUnchanged` whenever there was a paid
        subscription behind the change, and this is where it is read. A person
        who is not told is a person who finds out from their bank.
      */
      updateSubscription.mutate(
        { data: { plan } },
        {
          onSuccess: (answer) => {
            queryClient.invalidateQueries({ queryKey: getGetSubscriptionQueryKey() });
            // The body itself, not `answer.data`. `updateSubscription` returns
            // `customFetch<SubscriptionUsage>(…)`, which is the parsed JSON —
            // there is no envelope around it, so this read was one property
            // too deep and `unchanged` was always undefined. The server half
            // of this shipped and worked; the notice it exists to show could
            // not appear, and the only place the truth turned up was the card
            // statement a fortnight later, which is the exact outcome the
            // paragraph above says was fixed.
            const unchanged = (answer as { billingUnchanged?: { message: string; where: string } } | undefined)
              ?.billingUnchanged;
            if (unchanged) setBillingNotice(unchanged);
          },
        },
      );
      return;
    }

    setCheckoutFor(plan);
    setCheckoutError(null);
    try {
      const config = await fetchCheckoutConfig();
      await openCheckout(config, {
        plan,
        billingCycle: isYearly ? "annual" : "monthly",
        email: user?.email ?? undefined,
        // The webhook and this callback race, and either can win. Refetching
        // after a short delay costs one request and covers the common case
        // where the webhook lands first; the query is invalidated either way,
        // so a slow webhook simply shows up on the next visit.
        onPurchase: () => {
          setTimeout(
            () => queryClient.invalidateQueries({ queryKey: getGetSubscriptionQueryKey() }),
            2500,
          );
        },
      });
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : "Could not open checkout.");
    } finally {
      setCheckoutFor(null);
    }
  };


  const phone = usePhoneWidth();
  const [language, chooseLanguage] = useLandingLanguage();
  const { collapsed: navCollapsed, overDark: navOverDark } = useNavState();
  const rtl = language === "ar";
  const t = (phrase: Phrase) => say(phrase, language);

  /* The landing page paints the document, not just its own subtree — see the
     note on the wrapper below. Scoped to the mount so /app keeps its theme. */
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.pageTheme = "light";
    return () => {
      delete root.dataset.pageTheme;
    };
  }, []);

  /*
    A hash in the URL has to be honoured by us, because the browser cannot.

    Every upgrade path in the product points at `/#pricing`: the toast when a
    render is refused for minutes, the badge on the dashboard, the plan row on
    the account screen, the footer. All of them worked. None of them arrived.

    The reason is that the browser looks for `#pricing` while the document is
    still the empty shell Vite serves, before React has rendered a single
    section, so there is nothing to scroll to and the attempt is not retried.
    Then the app mounts and the person is at the top of a page whose pricing
    section begins 6,179 pixels down, with no error anywhere and nothing to
    suggest the link did not simply mean "the home page".

    Two passes, and both are needed. The first is as soon as the section exists.
    The second is half a second later, because the sections above it reveal on
    scroll and the hero art loads late, so the first landing is against a
    document that is still growing underneath it.

    `scrollIntoView` rather than a computed offset: the section is the thing
    somebody asked for, and letting the browser place it survives a header
    changing height. Instantly when the person has asked for less motion.
  */
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;

    const quiet = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const behavior: ScrollBehavior = quiet ? "auto" : "smooth";

    let settle: ReturnType<typeof setTimeout> | undefined;
    const land = () => {
      const target = document.getElementById(id);
      if (!target) return false;
      target.scrollIntoView({ behavior, block: "start" });
      return true;
    };

    // A frame, so the first paint has happened and the section has a height.
    const first = requestAnimationFrame(() => {
      if (!land()) return;
      settle = setTimeout(land, 500);
    });

    return () => {
      cancelAnimationFrame(first);
      if (settle) clearTimeout(settle);
    };
  }, []);

  return (
    /*
     * The landing page is light, whatever the app is set to.
     *
     * Two themes are right for a tool somebody sits in for an hour — a dark
     * editor at midnight is not a preference, it is the room. A landing page is
     * not that: it is read once, usually in daylight, usually from a link, and
     * maintaining two of it means every gradient, every glow and every one of
     * the wordmark's three stops has to be judged twice and stays half-judged.
     * One page, committed to, beats two that are each nearly right.
     *
     * `light` sets the whole token set on this subtree, so everything inside
     * inherits it no matter what class the theme script put on `<html>`, and
     * `color-scheme` makes the browser's own furniture inside it — scrollbars,
     * form controls — agree.
     *
     * Neither of those reaches the viewport, though. The page's own background
     * and the gutter you see when you overscroll are painted from `<html>`,
     * which the theme script left dark: measured, `body` was still rgb(10,9,11)
     * behind a fully light page, so a rubber-band scroll on a trackpad or a
     * phone flashed black at the top of it. The effect below marks the root for
     * as long as this page is mounted, and clears it on the way out so the app's
     * own theme is untouched. `.force-dark` regions inside are still dark: the
     * hero recording is a picture of a dark editor, and a picture of a dark
     * editor is dark on any page.
     */
    /*
     * `dir` and `lang` sit here rather than on `<html>`.
     *
     * Everything this page needs from them is inherited: the layout follows the
     * wrapper, and the two typographic rules Arabic needs are written as
     * `:where([dir="rtl"], [lang="ar"]) …` descendant selectors in index.css,
     * so a subtree is enough to reach them. Putting them on the document would
     * mean another attribute to unset on the way out, on a root the app also
     * uses, for a scrollbar that changes sides.
     *
     * `lang` as well as `dir`, and not only for screen readers: the sans stack
     * carries IBM Plex Sans Arabic after Inter, and the browser picks per
     * language, not per character.
     */
    <div
      className="light w-full flex flex-col items-center bg-background text-foreground"
      style={{ colorScheme: "light" }}
      dir={directionOf(language)}
      lang={language}
      data-testid="landing"
      ref={sectionsRef}
    >

      {/* ── Fixed global background canvas ── */}
      {/*
        One light source, not five.
        This was four overlapping purple radial washes plus two blurred orbs
        plus thirty drifting dots — six soft violet blobs with nothing between
        them, which is the exact look every generated landing page has had since
        2024, and it reads as one: cheap. A room lit from five directions has no
        shape.

        What replaces them is a single key light from above, and then
        *structure*: a faint grid the light falls across, and film grain over
        everything. Grain is what separates an expensive dark interface from a
        flat one — it breaks the banding a large gradient always has on an 8-bit
        display, and the eye reads the texture as depth rather than noise.
      */}
      <div className="fixed inset-0 pointer-events-none -z-10 overflow-hidden">
        {/* The key light. */}
        <div style={{
          position: "absolute", inset: 0,
          background: "radial-gradient(ellipse 90% 50% at 50% -10%, var(--wash-top) 0%, var(--wash-top-mid) 45%, transparent 72%)",
        }} />
        {/* One low bounce, off-centre, so the page is not symmetrical. */}
        <div style={{
          position: "absolute", inset: 0,
          background: "radial-gradient(ellipse 70% 45% at 22% 92%, var(--wash-left) 0%, transparent 60%)",
        }} />
        {/* The grid the light falls across. Masked to fade out with distance,
            so it is architecture near the top and gone by the fold. */}
        <div style={{
          position: "absolute", inset: 0,
          backgroundImage:
            "linear-gradient(to right, var(--grid-line) 1px, transparent 1px), linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          maskImage: "radial-gradient(ellipse 95% 75% at 50% 8%, black 0%, rgba(0,0,0,0.55) 45%, transparent 80%)",
          WebkitMaskImage: "radial-gradient(ellipse 95% 75% at 50% 8%, black 0%, rgba(0,0,0,0.55) 45%, transparent 80%)",
        }} />
        {/* The slow diagonal light sweep that used to be here is gone with the
            orbs. A second moving light with no source is the same tell — and it
            was 806px wide, so it was also the widest thing on a phone. */}

        {/* Grain, over everything. */}
        <div style={{
          position: "absolute", inset: 0,
          backgroundImage: "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E\")",
          backgroundRepeat: "repeat",
          backgroundSize: "128px 128px",
        }} className="grain-layer" />
      </div>

      {/* ── Header ── */}
      {/*
        The header is the tightest row on the page and the first thing a phone
        shows. At 390px it held a logo, a theme toggle, "Log in" and "Sign up
        free" — and "Log in" wrapped onto two lines and collided with the mark.
        Everything below is that row learning to be narrow: a smaller mark, a
        label that cannot wrap, and a preference control that steps aside for
        the two things somebody actually came here to press.
      */}
      {/*
        The bar is fixed now, so the page has to be told how tall it is. A
        spacer rather than padding on the hero: the hero is the element the
        parallax reads, and giving it a top padding that only exists because of
        another element is how a layout acquires a rule nobody can delete.
      */}
      <div aria-hidden className="h-[72px] sm:h-[88px]" />
      <div className="fixed inset-x-0 top-0 z-50 pointer-events-none">
        <header
          data-testid="landing-nav"
          data-collapsed={navCollapsed ? "true" : "false"}
          data-over-dark={navOverDark ? "true" : "false"}
          /* `force-dark` re-declares the whole palette on the header, so the
             capsule's own tokens, the wordmark and the two quiet labels all
             turn over together. Setting six colours by hand here would be the
             same change written six times and forgotten five. */
          className={`pointer-events-auto mx-auto flex items-center justify-between gap-2 animate-fade-in nav-shell text-foreground ${
            navCollapsed ? "nav-shell-capsule" : "nav-shell-wide"
          } ${navOverDark && navCollapsed ? "force-dark" : ""}`}
        >
        {/*
          The lockup, sized against the reference Osama sent rather than against
          itself.

          In that bar the mark and the wordmark are the *same height* — the mark
          is a wide, squat emblem about as tall as a capital letter, and the
          name is what you read. Ours had a 32px square mark beside a 13px cap,
          so the mark was two and a half times the writing and the bar read as
          an icon with a label after it. The mark comes down and the two now sit
          within half a cap-height of each other, which is as close as a square
          glyph gets to a squat one before it stops being legible.
        */}
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
          <Logo className="w-6 h-6 sm:w-7 sm:h-7 text-brand-mark flex-shrink-0" />
          <span className="font-bold text-base sm:text-lg tracking-tight">Editly</span>
        </div>
        {/* `lg`, not `md`.

              At 768 the section links appeared and the bar had 743px of content
              for 768px of room, so the mark — which carries `min-w-0` so it can
              shrink — squashed, and «Editly» printed over "Features". A tablet
              gets the mark, the language switch and the two doors; the section
              links come back when there is room for them. */}
          <nav className="hidden lg:flex items-center gap-5 lg:gap-7 text-sm font-medium text-muted-foreground">
          {/* The anchor is the section id, which is English and stays English:
              it is a URL, and a URL that changes with the reader's language is
              a link that breaks when it is shared. Only the label translates. */}
          {[
            { href: "#features", label: LANDING.nav.features },
            { href: "#podcasts", label: LANDING.nav.podcasts },
            { href: "#how-it-works", label: LANDING.nav.howItWorks },
            { href: "#pricing", label: LANDING.nav.pricing },
          ].map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="relative whitespace-nowrap hover:text-foreground transition-colors group"
            >
              {t(item.label)}
              <span className="absolute -bottom-0.5 start-0 w-0 h-px bg-primary transition-all duration-300 group-hover:w-full" />
            </a>
          ))}
        </nav>
        {/*
          Two doors, not one.

          The header used to offer only "Dashboard", which is a word that means
          nothing to someone who has never signed up and quietly implies they
          already have an account. A first-time visitor needs to be told where
          to start; a returning one needs a way back in that is not the same
          button. Once signed in both are noise, so they collapse back to the
          single destination that is actually theirs.
        */}
        <div className="flex items-center gap-1 sm:gap-2.5">
          {/* The theme control is gone from this page, with the theme. It
              lives in the app, on the screens where somebody sits long enough
              for it to matter. */}
          {/*
            The language switch, and it is a word rather than a globe.

            A globe icon is the international symbol for "a menu you have to
            open to find out what is in it". There are two languages, so the
            control says the other one in its own script: somebody who wants
            English sees the word English, and somebody who wants Arabic sees
            العربية. `lang` on the button is the language of its *label*, so
            the browser reaches for the right face for those letters.

            Sized to a thumb like everything else in this row, and it stands
            down to a quieter treatment than the two buttons somebody came here
            to press.
          */}
          <button
            type="button"
            onClick={() => chooseLanguage(rtl ? "en" : "ar")}
            data-testid="button-language"
            lang={rtl ? "en" : "ar"}
            title={t(LANDING.languageToggle.title)}
            className="px-2 sm:px-3 min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-md font-medium text-sm whitespace-nowrap text-muted-foreground hover:text-foreground hover:bg-surface-1 transition-colors"
          >
            {t(LANDING.languageToggle.label)}
          </button>
          {user ? (
            <Link
              href="/dashboard"
              data-testid="link-dashboard"
              className="glow-btn btn-gradient-cta text-white px-5 sm:px-6 min-h-[44px] inline-flex items-center rounded-md font-semibold whitespace-nowrap"
            >
              {t(LANDING.header.dashboard)}
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                data-testid="link-log-in"
                className="px-2 sm:px-4 min-h-[44px] inline-flex items-center rounded-md font-medium text-sm whitespace-nowrap text-muted-foreground hover:text-foreground hover:bg-surface-1 transition-colors"
              >
                <span className="sm:hidden">{t(LANDING.header.logInShort)}</span>
                <span className="hidden sm:inline">{t(LANDING.header.logIn)}</span>
              </Link>
              <Link
                href="/login?mode=signup"
                data-testid="link-sign-up"
                className="glow-btn btn-gradient-cta text-white px-4 sm:px-6 min-h-[44px] inline-flex items-center rounded-md font-semibold text-sm sm:text-base whitespace-nowrap"
              >
                <span className="sm:hidden">{t(LANDING.header.signUp)}</span>
                <span className="hidden sm:inline">{t(LANDING.header.signUpFree)}</span>
              </Link>
            </>
          )}
        </div>
        </header>
      </div>

      {/* ── Hero ── */}
      <section
        ref={heroRef}
        className="relative w-full max-w-7xl mx-auto px-6 pt-20 pb-32 flex flex-col items-center text-center overflow-hidden"
      >
        {/* The orbs and the thirty floating dots that used to be here are gone.
            Two 1000px blurred purple circles drifting behind the headline, with
            particles rising through them, is decoration that says nothing about
            the product and is the single most recognisable tell of a generated
            page. The lighting is on the fixed canvas above now, and the motion
            that is left belongs to things that mean something: the text
            arriving, the mock working, the timeline running. */}

        {/* Badge */}
        {/*
          The announcement pill, rebuilt against the reference Osama sent.

          Three things separate that pill from ours, and none of them is the
          text. It leads with a **tag** — a small filled capsule in the action
          colour, so the eye lands on "there is news" before it starts reading
          the news. It has **no border**: it is held off the page by a shadow,
          the same way every other surface in this system is. And it is
          **taller than its text**, with the tag insetting into the padding, so
          the pill reads as a container rather than as a line of text with
          rounded ends.

          What does not change is what it says. Noah is the thing this pill
          exists to introduce.
        */}
        <div
          className="inline-flex items-center gap-2 ps-1.5 pe-4 py-1.5 rounded-full bg-surface-1 border border-hairline-faint mb-8 backdrop-blur-md animate-fade-up shadow-[0_1px_2px_rgba(8,4,24,0.10),0_10px_28px_-14px_rgba(8,4,24,0.45)]"
          style={{ animationDelay: "100ms" }}
        >
          <span
            data-testid="badge-beta"
            className="inline-flex items-center rounded-full bg-cta text-cta-foreground px-2.5 h-6 text-xs font-bold tracking-tight shadow-[0_1px_1px_color-mix(in_srgb,black_30%,hsl(var(--cta-bloom))),0_4px_12px_-4px_color-mix(in_srgb,hsl(var(--cta-bloom))_60%,transparent)]"
          >
            {t(LANDING.hero.badgeTag)}
          </span>
          <Sparkles className="w-4 h-4 text-secondary animate-sparkle" />
          {/* Introduces the person the headline tells you to describe to, and
              claims nothing we have not built: no version number, nothing that
              reads as "we shipped a model". The result is one line further down,
              where it has room to be specific. */}
          <span className="text-sm font-medium text-foreground/80">{t(LANDING.hero.badge)}</span>
          <span className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.8)]"
            style={{ animation: "glow-pulse 2s ease-in-out infinite" }} />
        </div>

        {/* Headline */}
        <h1
          className="text-5xl md:text-7xl font-extrabold tracking-tight mb-6 max-w-4xl leading-[1.1] animate-fade-up"
          style={{ animationDelay: "200ms" }}
        >
          {/* Two voices, not one word in a different colour.
              The heavy grotesque states it and an italic serif answers — the
              pairing that makes an editorial headline read as set rather than
              typed. `.headline-serif` carries the size and tracking corrections
              an italic serif needs beside a bold sans, and the RTL rule that
              says the same thing with weight when there is no italic to use. */}
          <span className="glow-text">{t(LANDING.hero.headlineLead)}</span>
          <br />
          <span
            className="headline-serif animate-gradient-shift"
            style={{
              background: "linear-gradient(135deg, #50a1ed 0%, #79b7f1 40%, #87bef2 70%, #50a1ed 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
              backgroundSize: "200% 200%",
            }}
          >
            {t(LANDING.hero.headlineAnswer)}
          </span>
        </h1>

        {/* Subtext */}
        <p
          className="text-lg md:text-xl text-muted-foreground mb-12 max-w-2xl animate-fade-up"
          style={{ animationDelay: "320ms" }}
        >
          {t(LANDING.hero.subtext)}
        </p>

        {/* CTA Buttons */}
        <div
          className="flex flex-col sm:flex-row items-center gap-4 animate-fade-up"
          style={{ animationDelay: "440ms" }}
        >
          {/* Two different people read this button.
              Somebody signed out is being asked to start an account, and the
              thing that decides it is the price — so the button says the price.
              Somebody already signed in has an account and is looking at a
              landing page by accident; "start free" is meaningless to them and
              the only useful next step is the one thing the product does. */}
          <Link
            href={user ? "/dashboard" : "/login?mode=signup"}
            data-testid="link-hero-cta"
            className="glow-btn btn-gradient-cta flex items-center justify-center gap-2 text-white h-14 px-8 rounded-lg font-semibold text-lg"
          >
            <Play className="w-5 h-5 fill-current" />
            {user ? t(LANDING.hero.ctaSignedIn) : t(LANDING.hero.ctaSignedOut)}
          </Link>
          {/* This said "Watch Demo" and had no handler at all — the second
              largest thing on the page did nothing when pressed, and there is
              no demo film to play even if it had. What the page does have is
              the three steps further down, so the button goes there. A button
              that scrolls is worth more than a button that lies. */}
          <a
            href="#how-it-works"
            data-testid="link-hero-secondary"
            className="group flex items-center justify-center gap-2 h-14 px-8 rounded-lg font-semibold text-lg bg-surface-1 hover:bg-surface-1 border border-hairline transition-all duration-300 hover:border-primary/40 hover:shadow-[0_0_24px_rgba(80,161,237,0.2)] backdrop-blur-sm"
          >
            {t(LANDING.hero.secondary)}
            {/* The arrow points the way the language reads, and moves that way
                on hover. An arrow pointing right on a right-to-left page points
                back at where the reader came from. */}
            <ArrowRight
              className={`w-4 h-4 transition-transform duration-300 ${rtl ? "rotate-180 group-hover:-translate-x-1" : "group-hover:translate-x-1"}`}
            />
          </a>
        </div>

        {/* The hero is a drawing of the editor, not a recording of it.
            See `HeroEditor` above for why: the recording's largest element was
            an empty video pane, its type rendered at about eight pixels, and it
            cost 1.4MB across four files. */}
        <div
          ref={mockupRef}
          className="mt-16 sm:mt-20 w-full max-w-5xl animate-fade-up"
          style={{ animationDelay: "560ms" }}
        >
          <div
            className="rounded-2xl glass-panel glass-flat overflow-hidden border border-hairline p-1.5 sm:p-2"
            style={{
              boxShadow:
                "0 40px 80px rgba(80,161,237,0.28), 0 80px 160px rgba(80,161,237,0.10), 0 0 0 1px rgba(121, 183, 241,0.12)",
            }}
          >
            <HeroEditor phone={phone} language={language} />
          </div>
          <p className="mt-4 text-xs sm:text-sm text-muted-foreground text-center">
            {t(LANDING.hero.caption)}
          </p>
        </div>
      </section>

      {/* ── How It Works ── */}
      <HowItWorks t={t} rtl={rtl} />

      {/* ── The dark chapter: what it does, and what it does for a podcast ── */}
      {/*
        Two sections inside one band, and the pairing is the point.

        The podcasts section was `bg-band` on its own — a slightly recessed
        lavender, four shades from the section above it and three from the one
        below, which is to say it was not a band at all. A page that is one
        temperature the whole way down has no rhythm and nothing to close: the
        eye has no reason to stop anywhere, so it stops nowhere.

        Going dark is the cheapest rhythm there is and it costs no copy. What it
        does cost is *length*: a band shorter than the screen shows its opening
        horizon and its closing one in the same frame, and two lit curves at
        once read as a stripe rather than as a chapter with a beginning and an
        end. So the band holds both sections that belong together — what the
        product does, and what it does for the one format it is best at — and
        runs to a couple of screens, which is what the horizons need to work.

        `force-dark` pins the dark theme's tokens over the subtree, so the glass
        panels, the hairlines and the text inside are the *dark* product rather
        than the light one with its colours inverted — the same trick the hero
        mockup uses, and the reason nothing inside either section changed.

        `<Horizon />` supplies the dark as well as the light, which is why there
        is no `bg-` class here: the band's edges are curves, and a rectangular
        background painted behind them would fill in the very shape the curves
        exist to cut. `.horizon-fill` covers everything between them, where the
        shape no longer matters.
      */}
      <div className="force-dark horizon-band relative w-full text-foreground">
        <div className="horizon-fill" aria-hidden="true" />
        <Horizon />
        <Horizon foot />
        <div className="horizon-grain" aria-hidden="true" />

      {/* ── Features ── */}
      <section id="features" className="relative w-full max-w-7xl mx-auto px-6 pt-32 pb-24 sm:pt-40">
        <div className="grid md:grid-cols-2 gap-16 items-center">
          <div>
            <div className="reveal">
              <p className="text-primary text-sm font-semibold tracking-widest uppercase mb-3">{t(LANDING.features.eyebrow)}</p>
              <h2 className="text-4xl font-bold mb-6 leading-tight">{t(LANDING.features.title)}</h2>
            </div>
            {/* Five outcomes, not eleven mechanics.
                This was a checklist of everything the renderer can do, one
                switch per line — and a list that long is read as a list, which
                means it is skimmed and none of it lands. Nothing has been
                dropped from the product: each line here is the result, with the
                mechanics that produce it underneath, where they belong. Still
                kept honest by hand: everything named works today. */}
            <ul className="space-y-6">
              {LANDING.features.list
                .map((entry) => ({ title: t(entry.title), detail: t(entry.detail) }))
                .map((feat, i) => (
                  <li
                    key={feat.title}
                    className="reveal flex items-start gap-4 group"
                    style={{ transitionDelay: `${i * 80}ms` }}
                  >
                    <div className="w-9 h-9 mt-0.5 flex-shrink-0 rounded-full bg-primary/15 flex items-center justify-center border border-primary/30 shadow-[0_0_8px_rgba(80,161,237,0.2)] group-hover:shadow-[0_0_16px_rgba(80,161,237,0.5)] group-hover:border-primary/60 transition-all duration-300">
                      <CheckCircle2 className="w-4 h-4 text-secondary" />
                    </div>
                    <div>
                      <span className="block text-lg font-semibold group-hover:text-foreground transition-colors">
                        {feat.title}
                      </span>
                      <span className="block text-muted-foreground mt-1 leading-relaxed">{feat.detail}</span>
                    </div>
                  </li>
                ))}
            </ul>
            <div className="mt-10 reveal">
              <Link
                href="/dashboard"
                className="group inline-flex items-center gap-2 min-h-[44px] text-primary hover:text-secondary font-semibold transition-colors"
              >
                {t(LANDING.features.tryIt)}
                <Zap className="w-4 h-4 transition-transform group-hover:scale-125 group-hover:rotate-12" />
              </Link>
            </div>
          </div>

          {/* Four things, drawn rather than labelled.
              This was four squares with the words "B-Roll", "Captions" and
              "Transitions" in them — a legend for a picture that was not there,
              and on a page selling a *video* tool the emptiest thing on it.
              Each cell now shows the mechanic it names, in twenty lines of SVG:
              a cutaway laid over the main shot, a caption filling word by word,
              two shots dissolving across each other. No screenshots, and no
              stock — they are the shapes themselves. */}
          <div className="relative reveal">
            {/* A wash, painted rather than blurred.
                This was a solid circle with `blur(100px)` on it: a 334,000px
                surface the compositor re-rasterised through the filter pipeline
                on every frame it was on screen. A radial gradient produces the
                same soft falloff in one paint, for nothing. */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  "radial-gradient(ellipse at 50% 50%, hsl(var(--secondary) / 0.20) 0%, hsl(var(--secondary) / 0.10) 38%, transparent 72%)",
              }}
            />
            <div className="glass-panel glass-flat p-4 sm:p-6 rounded-2xl relative z-10 transition-all duration-500 hover:shadow-[0_0_60px_rgba(80,161,237,0.2)]">
              <div className="grid grid-cols-2 gap-3 sm:gap-4">
                {[
                  {
                    label: t(LANDING.features.grid[0].label),
                    hint: t(LANDING.features.grid[0].hint),
                    art: (
                      <svg viewBox="0 0 120 120" className="w-full h-full" aria-hidden="true">
                        <g transform={rtl ? MIRROR_CELL : undefined}>
                        <rect x="10" y="24" width="76" height="52" rx="6" className="fill-[var(--art-base)]" />
                        <rect x="10" y="24" width="76" height="52" rx="6" className="fill-none stroke-[var(--art-line)]" strokeWidth="1.5" />
                        {/* The cutaway, lifted off the shot beneath it. */}
                        <rect x="46" y="44" width="64" height="46" rx="6" className="fill-[var(--art-accent-soft)]" />
                        <rect x="46" y="44" width="64" height="46" rx="6" className="fill-none stroke-[var(--art-accent)]" strokeWidth="2" />
                        <path d="M62 60l18 9-18 9z" className="fill-[var(--art-accent)]" />
                        </g>
                      </svg>
                    ),
                  },
                  {
                    label: t(LANDING.features.grid[1].label),
                    hint: t(LANDING.features.grid[1].hint),
                    accent: true,
                    art: (
                      <svg viewBox="0 0 120 120" className="w-full h-full" aria-hidden="true">
                        <g transform={rtl ? MIRROR_CELL : undefined}>
                        {/* The waveform, with the flat stretches lifted out of
                            it — the one thing every take needs doing to it. */}
                        <g className="fill-[var(--art-accent)]">
                          {[6, 14, 22, 9, 26, 18].map((h, n) => (
                            <rect key={`a${n}`} x={16 + n * 8} y={60 - h} width="4" height={h * 2} rx="2" />
                          ))}
                        </g>
                        <g className="fill-[var(--art-line)]">
                          {[0, 1, 2].map((n) => (
                            <rect key={`g${n}`} x={64 + n * 8} y="58" width="4" height="4" rx="2" />
                          ))}
                        </g>
                        <g className="fill-[var(--art-accent)]">
                          {[20, 11, 24].map((h, n) => (
                            <rect key={`b${n}`} x={90 + n * 8} y={60 - h} width="4" height={h * 2} rx="2" />
                          ))}
                        </g>
                        {/* and where they went. */}
                        <path
                          d="M64 84h24"
                          className="stroke-[var(--art-accent)]"
                          strokeWidth="2"
                          strokeDasharray="4 4"
                          strokeLinecap="round"
                        />
                        <path d="M76 96l-5-6h10z" className="fill-[var(--art-accent)]" />
                        </g>
                      </svg>
                    ),
                  },
                  {
                    label: t(LANDING.features.grid[2].label),
                    hint: t(LANDING.features.grid[2].hint),
                    art: (
                      <svg viewBox="0 0 120 120" className="w-full h-full" aria-hidden="true">
                        <g transform={rtl ? MIRROR_CELL : undefined}>
                        <rect x="14" y="18" width="92" height="84" rx="8" className="fill-[var(--art-base)]" />
                        <rect x="14" y="18" width="92" height="84" rx="8" className="fill-none stroke-[var(--art-line)]" strokeWidth="1.5" />
                        {/* Filled, then half-filled, then waiting — the wipe. */}
                        <rect x="26" y="62" width="34" height="10" rx="5" className="fill-[var(--art-accent)]" />
                        <rect x="64" y="62" width="30" height="10" rx="5" className="fill-[var(--art-line)]" />
                        <rect x="64" y="62" width="13" height="10" rx="5" className="fill-[var(--art-accent)]" />
                        <rect x="26" y="78" width="46" height="10" rx="5" className="fill-[var(--art-line)]" />
                        </g>
                      </svg>
                    ),
                  },
                  {
                    label: t(LANDING.features.grid[3].label),
                    hint: t(LANDING.features.grid[3].hint),
                    art: (
                      <svg viewBox="0 0 120 120" className="w-full h-full" aria-hidden="true">
                        <defs>
                          <linearGradient id="dissolve-a" x1="0" x2="1">
                            <stop offset="0.35" stopColor="var(--art-accent)" stopOpacity="0.85" />
                            <stop offset="1" stopColor="var(--art-accent)" stopOpacity="0" />
                          </linearGradient>
                          <linearGradient id="dissolve-b" x1="0" x2="1">
                            <stop offset="0" stopColor="var(--art-line)" stopOpacity="0" />
                            <stop offset="0.65" stopColor="var(--art-line)" stopOpacity="1" />
                          </linearGradient>
                        </defs>
                        <g transform={rtl ? MIRROR_CELL : undefined}>
                        <rect x="8" y="34" width="70" height="52" rx="6" fill="url(#dissolve-a)" />
                        <rect x="42" y="34" width="70" height="52" rx="6" fill="url(#dissolve-b)" />
                        <rect x="8" y="34" width="104" height="52" rx="6" className="fill-none stroke-[var(--art-line)]" strokeWidth="1.5" />
                        </g>
                      </svg>
                    ),
                  },
                ].map((cell, i) => (
                  <div
                    key={i}
                    className={`aspect-square rounded-xl overflow-hidden border transition-all duration-300 cursor-default flex flex-col
                      ${cell.accent
                        ? "bg-primary/15 border-primary/40 shadow-[0_0_20px_rgba(80,161,237,0.18)] hover:shadow-[0_0_35px_rgba(80,161,237,0.4)]"
                        : "bg-band border-hairline-faint hover:border-hairline hover:bg-surface-1"
                      }`}
                  >
                    <div className="flex-1 min-h-0 p-2 sm:p-3">{cell.art}</div>
                    <div className="px-3 pb-3">
                      <p className="text-sm font-semibold leading-tight">{cell.label}</p>
                      <p className="text-xs text-muted-foreground leading-snug mt-0.5">{cell.hint}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── One recording, a week of posts ──
          The product has cut clips out of a long take since the renderer
          learned to, and nothing anywhere said so. "Video editing" is what
          twenty products call themselves; "your Tuesday recording is five
          posts by Wednesday" is a job somebody has. Every number and every
          name on this section is a thing that runs today — the templates are
          `three-clips` and `podcast-clip` in lib/templates.ts, and the titles
          come from the transcript the same way the captions do. */}
      <section id="podcasts" className="relative w-full pt-8 pb-32 sm:pb-40">
        <div className="w-full max-w-7xl mx-auto px-6 relative">
          <div className="max-w-2xl reveal">
            <p className="text-primary text-sm font-semibold tracking-widest uppercase mb-3">
              {t(LANDING.podcasts.eyebrow)}
            </p>
            <h2 className="text-4xl font-bold mb-4 leading-tight text-balance">
              {t(LANDING.podcasts.title)}
            </h2>
            <p className="text-muted-foreground text-lg leading-relaxed">
              {t(LANDING.podcasts.lead)}
            </p>
          </div>

          {/* The mechanism, in the order it happens. Three steps because there
              are three; a five-step diagram of a three-step process is a
              diagram somebody padded. */}
          <div className="grid md:grid-cols-3 gap-6 mt-12">
            {LANDING.podcasts.steps
              .map((entry) => ({ step: t(entry.step), detail: t(entry.detail) }))
              .map((item, i) => (
                <div
                  key={item.step}
                  className="reveal rounded-2xl glass-panel border border-hairline p-6"
                  style={{ transitionDelay: `${i * 90}ms` }}
                >
                {/* Numbered because this genuinely is a sequence — the clips
                    cannot be found before the file arrives. Ordinals on a set
                    of unordered things are decoration. */}
                  <div className="text-xs font-mono text-secondary mb-3" dir="ltr">
                    {String(i + 1).padStart(2, "0")}
                  </div>
                  <h3 className="text-lg font-semibold mb-2">{item.step}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{item.detail}</p>
                </div>
              ))}
          </div>

          <div className="reveal mt-10 flex flex-col sm:flex-row sm:items-center gap-4">
            {/* The same CTA the rest of this page uses. A `Button` here would
                be a different object on the one page whose whole job is to look
                like one product. */}
            <Link
              href="/login?mode=signup"
              data-testid="link-podcast-cta"
              className="glow-btn btn-gradient-cta inline-flex items-center justify-center text-white h-12 px-7 rounded-lg font-semibold whitespace-nowrap"
            >
              {t(LANDING.podcasts.cta)}
            </Link>
            <p className="text-sm text-muted-foreground">
              {t(LANDING.podcasts.noteLead)} <strong>{t(LANDING.podcasts.noteThreeClips)}</strong>{" "}
              {t(LANDING.podcasts.noteAnd)} <strong>{t(LANDING.podcasts.notePodcastClip)}</strong>.{" "}
              {t(LANDING.podcasts.noteTail)}
            </p>
          </div>
        </div>
      </section>
      </div>

      {/* ── Pricing ── */}
      <section id="pricing" className="w-full max-w-7xl mx-auto px-6 py-24">
        <div className="text-center mb-10 reveal">
          {/* A step down from the other section headings, and balanced: this
              line is longer than they are, and at 5xl it wrapped with a single
              word stranded on the second line. */}
          <h2 className="text-3xl md:text-4xl font-bold mb-4 glow-text max-w-3xl mx-auto text-balance">
            {t(LANDING.pricing.title)}
          </h2>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto">
            {t(LANDING.pricing.lead)}
          </p>
        </div>

        {/* Billing toggle */}
        <div className="flex justify-center mb-10">
          <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-surface-1 border border-hairline backdrop-blur-sm">
            <button
              onClick={() => setIsYearly(false)}
              className={`px-6 min-h-[44px] rounded-md text-sm font-medium transition-all duration-300 ${
                !isYearly
                  ? "bg-primary text-white shadow-[0_0_16px_rgba(80,161,237,0.5)]"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(LANDING.pricing.monthly)}
            </button>
            <button
              onClick={() => setIsYearly(true)}
              className={`flex items-center justify-center gap-2 px-6 min-h-[44px] rounded-md text-sm font-medium transition-all duration-300 ${
                isYearly
                  ? "bg-primary text-white shadow-[0_0_16px_rgba(80,161,237,0.5)]"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(LANDING.pricing.yearly)}
              {/* The one thing on this page that is not the brand colour.
                  A saving has to jump off a section whose every other accent is
                  violet, and a second violet does not jump. `--deal` is 80
                  degrees round the wheel: far enough to read as a different
                  kind of thing, close enough to belong to the same product. */}
              <span
                className="text-[10px] font-bold px-2 py-0.5 rounded-full border transition-all duration-300 text-deal"
                style={{ backgroundColor: "var(--deal-soft)", borderColor: "var(--deal-edge)" }}
              >
                {t(LANDING.pricing.save)}
              </span>
            </button>
          </div>
        </div>

        {/* The free tier, where a visitor can actually see it.
            It sat in the database and nowhere else, so a page whose cheapest
            number was $12 read as "no free tier" — and the thing that costs us
            nothing to give away is the only way anyone finds out whether the
            editing is any good. */}
        <div
          className="mb-8 rounded-2xl glass-panel border border-hairline px-6 py-5 flex flex-col md:flex-row md:items-center gap-4 md:gap-8 reveal"
          data-testid="free-tier"
        >
          <div className="flex-shrink-0">
            {/*
              The four pricing sentences whose English half is not in the copy
              file. It lives in `lib/pricing.ts`, which `tools/pricing-test.mjs`
              reads beside the plan limits the server enforces, and a second
              English copy here would be a page promising minutes nothing checks.
              So the pair is built at the point of use: Arabic from the copy,
              English from the module that is kept honest.
            */}
            <div className="text-sm font-semibold text-primary">
              {t(phrase(PRICING_AR.free.headline, FREE_TIER.headline))}
            </div>
            <div className="text-3xl font-bold mt-1">
              {/* The price is a number and a currency sign, which are read left
                  to right in Arabic too. The unit beside it is a word, and it
                  translates. */}
              <span dir="ltr">$0</span>
              <span className="text-base font-medium text-muted-foreground">{t(LANDING.pricing.perMonth)}</span>
            </div>
          </div>
          <ul className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
            {FREE_TIER.lines
              .map((line, i) => t(phrase(PRICING_AR.free.lines[i] ?? line, line)))
              .map((line) => (
                <li key={line} className="text-sm text-muted-foreground flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0 text-primary/70" />
                  <span>{line}</span>
                </li>
              ))}
          </ul>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-stretch">
          {PLANS.map((plan, i) => {
            const isCurrent = planKnown && subscription?.plan === plan.key;
            const isPro = "popular" in plan && plan.popular;
            const isDowngrade = planKnown && RANK[plan.key] < RANK[currentPlan];
            return (
              <div
                key={plan.key}
                className={`reveal relative flex flex-col rounded-3xl border transition-all duration-500 overflow-hidden ${
                  isPro
                    ? "border-primary/60 shadow-[0_0_50px_rgba(80,161,237,0.25)] bg-surface-2"
                    : "border-hairline bg-surface-1 hover:border-hairline-strong"
                }`}
                style={{
                  transitionDelay: `${i * 80}ms`,
                  boxShadow: isPro
                    ? "inset 0 1px 0 rgba(255,255,255,0.1), 0 0 50px rgba(80,161,237,0.25)"
                    : "inset 0 1px 0 rgba(255,255,255,0.05)",
                }}
              >
                {isPro && (
                  <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent" />
                )}
                {isPro && (
                  <div className="absolute top-4 end-4">
                    <span className="text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full bg-primary/20 text-primary border border-primary/30">
                      {t(LANDING.pricing.mostPopular)}
                    </span>
                  </div>
                )}

                <div className="p-8 flex flex-col flex-1">
                  <div className="mb-6">
                    <h3 className="text-xl font-bold mb-1">{plan.name}</h3>
                    <div className="mt-3 transition-all duration-300">
                      <div className="flex items-baseline gap-1">
                        {/* The number rolls rather than being replaced.
                            There was a `transition` on this span, which does
                            nothing: transitions interpolate properties and the
                            text of a node is not one. The yearly toggle is the
                            only interaction in this section and it had no
                            feedback at all — $12 simply became $115 between two
                            frames. Rolling also says which *way* the number
                            went, which on a pricing page is the point. */}
                        {/* The currency sign is part of the number, not a
                            sibling of it: the row's `gap-1` was putting four
                            pixels between "$" and "115", which reads as two
                            things rather than a price. */}
                        <span className="flex items-baseline text-4xl font-bold" dir="ltr">
                          $
                          <RollingNumber
                            value={String(isYearly ? plan.yearlyPrice : plan.price)}
                            testId={`price-${plan.key}`}
                          />
                        </span>
                        <span className="text-muted-foreground text-sm">
                          {isYearly ? t(LANDING.pricing.perYear) : t(LANDING.pricing.perMonth)}
                        </span>
                      </div>
                      <p className={`text-xs text-muted-foreground mt-1.5 transition-all duration-300 ${isYearly ? "opacity-100" : "opacity-0 h-0 mt-0 overflow-hidden"}`}>
                        {t(phrase(PRICING_AR.plans[plan.key].yearlyPerMonth, plan.yearlyPerMonth))}
                      </p>
                    </div>
                  </div>

                  <div className="mb-6 space-y-2">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <span className="text-2xl">{plan.minutes}</span>
                      <span className="text-muted-foreground">{t(LANDING.pricing.minutesLabel)}</span>
                    </div>
                    <div className="text-sm text-muted-foreground">{t(phrase(PRICING_AR.plans[plan.key].upload, plan.upload))}</div>
                    <div className="text-xs text-muted-foreground/70 mt-1">{t(phrase(PRICING_AR.plans[plan.key].forWho, plan.forWho))}</div>
                  </div>

                  <div className="h-px bg-surface-1 mb-6" />

                  <ul className="space-y-3 flex-1 mb-8">
                    {SHARED_FEATURES.map((feat, i) => t(phrase(PRICING_AR.shared[i] ?? feat, feat))).map((feat) => (
                      <li key={feat} className="flex items-center gap-3 text-sm">
                        <div className="w-5 h-5 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center flex-shrink-0">
                          <CheckCircle2 className="w-3 h-3 text-primary" />
                        </div>
                        {feat}
                      </li>
                    ))}
                  </ul>

                  {isCurrent ? (
                    <div className="flex items-center justify-center gap-2 rounded-md py-3 px-6 bg-primary/10 border border-primary/30 text-primary font-semibold text-sm">
                      <Check className="w-4 h-4" />
                      {t(LANDING.pricing.currentPlan)}
                    </div>
                  ) : (
                    <button
                      onClick={() => handleSelectPlan(plan.key)}
                      disabled={!planKnown || updateSubscription.isPending || checkoutFor !== null}
                      data-testid={`button-plan-${plan.key}`}
                      className={`w-full rounded-md py-3 px-6 font-semibold text-sm transition-all duration-300 ${
                        isPro
                          ? "btn-gradient-cta text-white"
                          : "bg-surface-1 border border-hairline hover:bg-surface-2 hover:border-hairline-strong hover:shadow-[0_0_20px_rgba(80,161,237,0.12)]"
                      } disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                      {!planKnown
                        ? t(LANDING.pricing.checkingPlan)
                        : checkoutFor === plan.key
                        ? t(LANDING.pricing.openingCheckout)
                        : isDowngrade
                        ? updateSubscription.isPending
                          ? t(LANDING.pricing.switching)
                          : `${t(LANDING.pricing.switchTo)} ${plan.name}`
                        : `${t(LANDING.pricing.get)} ${plan.name}`}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {checkoutError && (
          <p
            role="alert"
            data-testid="text-checkout-error"
            className="text-center text-sm text-destructive mt-6 max-w-md mx-auto"
          >
            {checkoutError}
          </p>
        )}
        {billingNotice && (
          <div
            role="status"
            data-testid="text-billing-unchanged"
            className="mt-6 max-w-md mx-auto rounded-xl border border-hairline bg-surface-1 p-4 text-sm"
          >
            <p dir="auto">{billingNotice.message}</p>
            <a
              href={billingNotice.where}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline font-medium inline-flex min-h-11 items-center"
              data-testid="link-cancel-billing"
            >
              {t(LANDING.pricing.cancelWhereBought)}
            </a>
          </div>
        )}
        <p className="text-center text-xs text-muted-foreground mt-8 opacity-60">
          {t(LANDING.pricing.footnote)}
        </p>
      </section>

      {/* ── Footer CTA ── */}
      {/*
        The close stays on the page's own ground — there is exactly one dark
        band on this page, and it is the podcasts section.

        What is gone from here is the *stack*: a violet tint over a violet
        radial over an animated violet hairline, three effects each saying
        "something is happening" and together saying nothing. One slow aurora in
        the brand violet and the action red, behind a bigger headline, with the
        sign-up as the only saturated object on the screen — which is the point
        of a closing section.
      */}
      <section className="w-full py-28 sm:py-36 text-center relative overflow-hidden">
        <div className="horizon-aurora horizon-aurora-light" aria-hidden="true" />

        <div className="relative z-10 flex flex-col items-center reveal px-6">
          <h2 className="text-4xl md:text-6xl font-bold tracking-tight mb-5 glow-text text-balance max-w-3xl">{t(LANDING.closing.title)}</h2>
          <p className="text-muted-foreground text-lg mb-10 max-w-lg">
            {t(LANDING.closing.leadFirst)}
            <br />
            {t(LANDING.closing.leadSecond)}
          </p>
          <Link
            href="/dashboard"
            className="glow-btn btn-gradient-cta animate-glow-pulse text-white h-16 px-12 rounded-lg font-bold text-xl flex items-center gap-3"
          >
            {t(LANDING.closing.cta)}
            <Zap className="w-5 h-5" />
          </Link>
          <p className="text-xs text-muted-foreground mt-5 opacity-60">{t(LANDING.closing.note)}</p>
        </div>
      </section>

      {/* ── Footer ──
          One quiet row. The affiliate link is the only load-bearing part: the
          program lives in the Freemius customer portal, and a program nobody
          can find pays nobody. The terms are stated in the link text because
          "become an affiliate" alone gives no reason to click it. */}
      {/* ── Footer ──
          The wordmark is the footer, not a line above one.
          A footer that is a row of small grey links is the last thing anybody
          sees and it says the page ended because it ran out. Setting the name
          at the size of a sign, with the light of the page still on it, closes
          the page deliberately — and it costs nothing but type, which is the
          only reason it can be done well without a photograph.
          The links keep their thumb-sized rows underneath. */}
      <footer className="w-full border-t border-hairline-faint overflow-hidden">
        <div className="max-w-6xl mx-auto px-6 pt-16 pb-10">
          {/* `clamp` rather than breakpoints: the mark should be as wide as the
              column allows at every width, not four fixed sizes with awkward
              gaps between them. `1px` of tracking taken back at the top end,
              because a face this large sets loose. */}
          <div
            aria-hidden="true"
            className="select-none font-extrabold leading-[0.95] tracking-[-0.045em] pointer-events-none -mb-[0.12em]"
            style={{
              // Sized to *fill the column*, which is the whole idea — a mark
              // that stops two thirds of the way across reads as a heading that
              // grew rather than as a sign. Six characters of a heavy grotesque
              // at this tracking come to roughly 3.3 ems wide, so the width of
              // the content column divided by 3.3 is the size, and `min` caps
              // it at the container so it never overflows on a wide screen.
              // `leading-[0.95]` rather than tighter: the descender on the `y`
              // is part of the letterform, and clipping it is a mistake nobody
              // reads as a choice.
              fontSize: "min(24vw, 21.5rem)",
              // Solid for most of its height, then away — the fade is the last
              // fifth, not the whole letterform, or the mark reads as washed
              // out rather than as lit from above.
              backgroundImage:
                "linear-gradient(180deg, var(--wordmark-top) 0%, var(--wordmark-top) 42%, var(--wordmark-mid) 78%, var(--wordmark-bottom) 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            Editly
          </div>
          {/* The glow the mark sits in, not on it — a text-shadow on a clipped
              gradient paints over the letterforms. */}
          <div
            aria-hidden="true"
            className="relative h-0"
          >
            {/* The gradient was already soft; the `blur(70px)` on top of it was
                paying the filter pipeline to soften an edge that does not
                exist. The stops carry the falloff instead. */}
            <div
              className="absolute start-1/4 -top-24 w-1/2 h-40 pointer-events-none opacity-70"
              style={{
                background:
                  "radial-gradient(ellipse at center, var(--wordmark-bloom) 0%, var(--wordmark-bloom) 18%, transparent 78%)",
              }}
            />
          </div>

          <div className="mt-10 grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-8 text-sm">
            <div>
              <p className="text-xs uppercase tracking-widest text-muted-foreground/70 mb-3">{t(LANDING.footer.product)}</p>
              <ul className="flex flex-col">
                <li><a href="/#how-it-works" className="min-h-11 inline-flex items-center text-muted-foreground hover:text-foreground transition-colors">{t(LANDING.footer.howItWorks)}</a></li>
                <li><a href="/#features" className="min-h-11 inline-flex items-center text-muted-foreground hover:text-foreground transition-colors">{t(LANDING.footer.features)}</a></li>
                <li><a href="/#podcasts" className="min-h-11 inline-flex items-center text-muted-foreground hover:text-foreground transition-colors">{t(LANDING.footer.podcasts)}</a></li>
                <li><a href="/#pricing" className="min-h-11 inline-flex items-center text-muted-foreground hover:text-foreground transition-colors">{t(LANDING.footer.pricing)}</a></li>
              </ul>
            </div>
            <div>
              <p className="text-xs uppercase tracking-widest text-muted-foreground/70 mb-3">{t(LANDING.footer.account)}</p>
              <ul className="flex flex-col">
                <li><Link href="/login" className="min-h-11 inline-flex items-center text-muted-foreground hover:text-foreground transition-colors">{t(LANDING.footer.logIn)}</Link></li>
                <li><Link href="/login?mode=signup" className="min-h-11 inline-flex items-center text-muted-foreground hover:text-foreground transition-colors">{t(LANDING.footer.createAccount)}</Link></li>
                <li><Link href="/dashboard" className="min-h-11 inline-flex items-center text-muted-foreground hover:text-foreground transition-colors">{t(LANDING.footer.yourProjects)}</Link></li>
              </ul>
            </div>
            <div>
              <p className="text-xs uppercase tracking-widest text-muted-foreground/70 mb-3">{t(LANDING.footer.earn)}</p>
              <ul className="flex flex-col">
                <li>
                  <a
                    href="https://users.freemius.com/"
                    target="_blank"
                    rel="noreferrer"
                    className="min-h-11 inline-flex items-center text-muted-foreground hover:text-foreground transition-colors"
                    data-testid="link-become-affiliate"
                  >
                    {t(LANDING.footer.affiliate)}
                  </a>
                </li>
                {/* The number is the offer. Under the link rather than inside
                    it, so the link stays a link and the terms stay readable. */}
                <li className="text-xs text-muted-foreground/70 leading-relaxed max-w-[16rem] pt-1">
                  {t(LANDING.footer.affiliateTerms)}
                </li>
              </ul>
            </div>
          </div>

          {/* The two documents every platform review asks for before it will
              look at an app, and the two a person is entitled to read *before*
              signing up rather than after. In the last row rather than a column
              of their own: they are not a feature, and putting them beside the
              product links would suggest they are. */}
          <div className="mt-10 pt-6 border-t border-hairline-faint flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground/70">
            <span dir="ltr">© {new Date().getFullYear()} Editly</span>
            <span className="flex items-center gap-4">
              <Link href="/privacy" className="min-h-11 inline-flex items-center hover:text-foreground transition-colors">{t(LANDING.footer.privacy)}</Link>
              <Link href="/terms" className="min-h-11 inline-flex items-center hover:text-foreground transition-colors">{t(LANDING.footer.terms)}</Link>
            </span>
            <span>{t(LANDING.footer.tagline)}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
