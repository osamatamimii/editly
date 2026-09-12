/**
 * Five drawings, one per claim, and nothing on them that is not the claim.
 *
 * The rule the rest of this page already follows: no screenshots and no stock.
 * A screenshot of an editor is a picture of a timeline, which is the thing this
 * product exists to stop somebody looking at — and every screenshot on a
 * landing page is out of date by the second release. These are the shapes
 * themselves, in the same token vocabulary as the drawings further down the
 * page, so they take the theme with them and cost one paint.
 *
 * Two constraints shaped every one of them.
 *
 * **No text.** Type inside an SVG is the one thing that does not mirror for
 * free, does not take the page's font, and cannot be translated by the copy
 * file. Everything here says what it means in shapes: a bar is a stretch of
 * sound, a block is a shot, a rounded rectangle is a frame. The words live
 * beside the picture where they can be read in either language.
 *
 * **Nothing that runs.** No animation, no filter, no gradient with a dozen
 * stops. A landing page that keeps a compositor busy while it is on screen
 * pays for it in the one measurement that matters on a phone, and the movement
 * on this section is the crossfade between panels — which happens when somebody
 * asks for it by scrolling, and then stops.
 *
 * Each drawing is a function of `rtl` because half of these are *flows* — this
 * became that — and a flow that reads left to right on an Arabic page is a
 * sentence running backwards. The ones that are compositions rather than
 * sequences are left alone, which is the same rule `mirrored()` states on the
 * page itself.
 */
import type { ReactElement } from "react";

/**
 * The grid every drawing is composed on. Not the box each one is shown through
 * — see `Frame` — just the shared page their coordinates are positions on.
 */
const W = 320;
const H = 200;
/**
 * The mirror, about whatever box is being shown.
 *
 * `translate(X,0) scale(-1,1)` maps `x` to `X - x`, so the axis is only in the
 * middle of the picture when `X` is the picture's full width. A drawing shown
 * through a tighter box needs its own `X` - `2 * x0 + width` - and using 320
 * for all of them would slide every mirrored drawing sideways out of frame by
 * exactly the margin that was trimmed. Which is the kind of mistake that is
 * invisible in the language it was written in.
 */
const flipAbout = (x0: number, width: number) => `translate(${2 * x0 + width},0) scale(-1,1)`;

/**
 * A drawing, shown through the smallest box that contains it.
 *
 * Every drawing is composed on the same 320x200 grid, because a shared grid is
 * what makes five pictures look like one set. What they do *not* share is how
 * much of it they use: the flow in 01 is wide and short, the composition in 03
 * fills the square. Shown through the full grid, the loose ones float in a
 * quarter-card of nothing, and the set reads as five drawings at five different
 * sizes - the exact impression this section is meant not to give.
 *
 * So `box` is the part of the grid a drawing actually occupies, and the SVG is
 * cropped to it. The picture scales up to meet the panel; the grid it was drawn
 * on does not change, so the coordinates in each drawing below stay readable
 * as positions on one shared page.
 */
function Frame({
  children,
  rtl,
  flow = true,
  box = [0, 0, W, H],
}: {
  children: React.ReactNode;
  rtl: boolean;
  flow?: boolean;
  /** `[x, y, width, height]` on the 320x200 grid. */
  box?: [number, number, number, number];
}) {
  const [x, y, width, height] = box;
  return (
    <svg viewBox={`${x} ${y} ${width} ${height}`} className="w-full h-full" aria-hidden="true">
      <g transform={flow && rtl ? flipAbout(x, width) : undefined}>{children}</g>
    </svg>
  );
}

const BASE = "fill-[var(--art-base)]";
const LINE = "stroke-[var(--art-line)]";
const ACCENT = "fill-[var(--art-accent)]";
const ACCENT_LINE = "stroke-[var(--art-accent)]";
const ACCENT_SOFT = "fill-[var(--art-accent-soft)]";
const DIM = "fill-[var(--art-dim)]";
const OK = "fill-[var(--art-ok)]";

/**
 * 01 — A raw take becomes a post.
 *
 * The whole promise in one picture: a wide take with dead stretches in it, the
 * dead stretches gone, and what is left standing up as a vertical post with its
 * levels evened. Left to right, so it mirrors.
 */
function rawTakeBecomesPost(rtl: boolean) {
  const kept = [
    { x: 16, w: 26 },
    { x: 50, w: 18 },
    { x: 76, w: 30 },
  ];
  return (
    <Frame rtl={rtl} box={[6, 22, 286, 140]}>
      {/* The take, with the silences drawn as the holes they are. */}
      <rect x="12" y="40" width="112" height="44" rx="6" className={BASE} />
      <rect x="12" y="40" width="112" height="44" rx="6" className={`fill-none ${LINE}`} strokeWidth="1.5" />
      {kept.map((k) => (
        <rect key={k.x} x={k.x} y="52" width={k.w} height="20" rx="3" className={ACCENT} opacity="0.85" />
      ))}
      {[44, 70].map((x) => (
        <g key={x}>
          <line x1={x} y1="48" x2={x} y2="76" className={ACCENT_LINE} strokeWidth="1.5" strokeDasharray="3 3" />
        </g>
      ))}

      {/* Closed up. The same three stretches, shoulder to shoulder. */}
      <rect x="12" y="104" width="112" height="44" rx="6" className={BASE} />
      <rect x="12" y="104" width="112" height="44" rx="6" className={`fill-none ${LINE}`} strokeWidth="1.5" />
      {[0, 1, 2].reduce<{ nodes: ReactElement[]; at: number }>(
        (acc, i) => {
          const w = kept[i].w;
          acc.nodes.push(
            <rect key={i} x={16 + acc.at} y="116" width={w} height="20" rx="3" className={ACCENT} opacity="0.85" />,
          );
          acc.at += w + 3;
          return acc;
        },
        { nodes: [], at: 0 },
      ).nodes}

      {/* The arrow between the two halves of the picture. */}
      <path d="M140 96h26" className={ACCENT_LINE} strokeWidth="2" strokeLinecap="round" />
      <path d="M172 96l-9-5v10z" className={ACCENT} />

      {/* And what comes out: a vertical frame with a level meter beside it. */}
      <rect x="188" y="28" width="72" height="128" rx="8" className={ACCENT_SOFT} />
      <rect x="188" y="28" width="72" height="128" rx="8" className={`fill-none ${ACCENT_LINE}`} strokeWidth="2" />
      <rect x="200" y="120" width="48" height="7" rx="3.5" className={ACCENT} opacity="0.9" />
      <rect x="200" y="132" width="32" height="7" rx="3.5" className={ACCENT} opacity="0.55" />
      <g className={DIM}>
        {[0, 1, 2, 3, 4, 5, 6].map((n) => (
          <rect key={n} x={276} y={140 - n * 16} width="10" height="10" rx="2" opacity={n > 4 ? 0.35 : 1} />
        ))}
      </g>
    </Frame>
  );
}

/**
 * 02 — The moments worth keeping, found for you.
 *
 * A long recording with three windows lifted out of it, each landing as its own
 * post with a line of title under it. The lift is the point, so it mirrors.
 */
function momentsFound(rtl: boolean) {
  const windows = [
    { x: 30, w: 34 },
    { x: 122, w: 30 },
    { x: 214, w: 38 },
  ];
  return (
    <Frame rtl={rtl} box={[6, 14, 308, 178]}>
      <rect x="12" y="24" width="296" height="34" rx="6" className={BASE} />
      <rect x="12" y="24" width="296" height="34" rx="6" className={`fill-none ${LINE}`} strokeWidth="1.5" />
      {/* The take itself, drawn as speech rather than as a bar. */}
      <g className={DIM}>
        {Array.from({ length: 46 }, (_, n) => {
          const h = 4 + ((n * 7) % 13);
          return <rect key={n} x={20 + n * 6.2} y={41 - h / 2} width="2.6" height={h} rx="1.3" />;
        })}
      </g>
      {windows.map((w) => (
        <rect key={w.x} x={w.x} y="20" width={w.w} height="42" rx="5" className={`fill-none ${ACCENT_LINE}`} strokeWidth="2" />
      ))}

      {windows.map((w, i) => (
        <g key={`drop${w.x}`}>
          <path d={`M${w.x + w.w / 2} 66v12`} className={ACCENT_LINE} strokeWidth="1.5" strokeDasharray="3 3" />
          <rect x={w.x + w.w / 2 - 34} y="84" width="68" height="76" rx="7" className={ACCENT_SOFT} />
          <rect
            x={w.x + w.w / 2 - 34}
            y="84"
            width="68"
            height="76"
            rx="7"
            className={`fill-none ${ACCENT_LINE}`}
            strokeWidth="1.5"
          />
          {/* The title, which comes from what was said in it. */}
          <rect x={w.x + w.w / 2 - 26} y="168" width={i === 1 ? 36 : 52} height="6" rx="3" className={DIM} />
          <rect x={w.x + w.w / 2 - 26} y="180" width={i === 2 ? 28 : 38} height="6" rx="3" className={DIM} opacity="0.5" />
        </g>
      ))}
    </Frame>
  );
}

/**
 * 03 — Captions in your own words.
 *
 * A frame with a caption block on it, one word lit the way the karaoke style
 * lights the word being said. A composition rather than a flow, so it does not
 * mirror: the frame is a frame in both languages, and flipping it would put the
 * safe area on the wrong side of a picture that has no direction.
 */
function captionsInYourWords(rtl: boolean) {
  const line1 = [26, 40, 18, 34];
  const line2 = [30, 22, 46];
  return (
    <Frame rtl={rtl} flow={false} box={[18, 10, 284, 180]}>
      <rect x="94" y="16" width="132" height="168" rx="10" className={BASE} />
      <rect x="94" y="16" width="132" height="168" rx="10" className={`fill-none ${LINE}`} strokeWidth="1.5" />
      {/* Somebody in the frame, at the size a shoulder-up shot puts them. */}
      <circle cx="160" cy="78" r="21" className={DIM} opacity="0.55" />
      <path d="M126 140a34 34 0 0 1 68 0z" className={DIM} opacity="0.55" />

      {/* The caption block, two balanced lines, with the spoken word lit. */}
      <g>
        {line1.reduce<{ nodes: ReactElement[]; at: number }>(
          (acc, w, i) => {
            acc.nodes.push(
              <rect
                key={`a${i}`}
                x={104 + acc.at}
                y="146"
                width={w}
                height="9"
                rx="4.5"
                className={i === 2 ? ACCENT : DIM}
                opacity={i === 2 ? 1 : 0.75}
              />,
            );
            acc.at += w + 6;
            return acc;
          },
          { nodes: [], at: 0 },
        ).nodes}
        {line2.reduce<{ nodes: ReactElement[]; at: number }>(
          (acc, w, i) => {
            acc.nodes.push(
              <rect key={`b${i}`} x={112 + acc.at} y="161" width={w} height="9" rx="4.5" className={DIM} opacity="0.45" />,
            );
            acc.at += w + 6;
            return acc;
          },
          { nodes: [], at: 0 },
        ).nodes}
      </g>

      {/* Read one way on the left of the frame and the other on the right:
          the same words, laid out in the direction each language reads. */}
      <g className={DIM} opacity="0.5">
        {[0, 1, 2].map((n) => (
          <rect key={`l${n}`} x={24} y={70 + n * 14} width={54 - n * 12} height="7" rx="3.5" />
        ))}
        {[0, 1, 2].map((n) => (
          <rect key={`r${n}`} x={242 + n * 12} y={70 + n * 14} width={54 - n * 12} height="7" rx="3.5" />
        ))}
      </g>
    </Frame>
  );
}

/**
 * 04 — It looks edited, not processed.
 *
 * Three things at once, because that is what the claim is: two shots crossing
 * over each other rather than butting together, a music bed stepping out of the
 * way of a voice, and a grade. A composition, so it stays put.
 */
function looksEdited(rtl: boolean) {
  return (
    <Frame rtl={rtl} flow={false} box={[10, 14, 300, 172]}>
      {/* The dissolve: two shots overlapping, with the overlap drawn. */}
      <rect x="16" y="20" width="128" height="72" rx="7" className={BASE} />
      <rect x="16" y="20" width="128" height="72" rx="7" className={`fill-none ${LINE}`} strokeWidth="1.5" />
      <rect x="96" y="34" width="128" height="72" rx="7" className={ACCENT_SOFT} />
      <rect x="96" y="34" width="128" height="72" rx="7" className={`fill-none ${ACCENT_LINE}`} strokeWidth="1.5" />
      <rect x="96" y="34" width="48" height="58" className={ACCENT} opacity="0.16" />

      {/* The grade: three chips, one of them chosen. */}
      <g>
        {[0, 1, 2].map((n) => (
          <rect
            key={n}
            x={244 + (n % 2) * 0}
            y={20 + n * 30}
            width="60"
            height="22"
            rx="6"
            className={n === 1 ? ACCENT : DIM}
            opacity={n === 1 ? 0.9 : 0.4}
          />
        ))}
      </g>

      {/* The duck: a bed that dips under the voice and comes back. */}
      <rect x="16" y="128" width="288" height="52" rx="7" className={BASE} />
      <rect x="16" y="128" width="288" height="52" rx="7" className={`fill-none ${LINE}`} strokeWidth="1.5" />
      <path
        d="M28 146h52c10 0 10 20 20 20h72c10 0 10-20 20-20h80"
        className={`fill-none ${ACCENT_LINE}`}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <g className={DIM}>
        {Array.from({ length: 14 }, (_, n) => {
          const h = 6 + ((n * 5) % 11);
          return <rect key={n} x={104 + n * 8} y={168 - h} width="3" height={h} rx="1.5" opacity="0.8" />;
        })}
      </g>
    </Frame>
  );
}

/**
 * 05 — It finishes without you.
 *
 * A closed window, work still going on behind it, and the result locked to one
 * account. The sequence is closed-then-carries-on, so it mirrors.
 */
function finishesWithoutYou(rtl: boolean) {
  return (
    <Frame rtl={rtl} box={[10, 34, 300, 132]}>
      {/* The tab, closed. */}
      <rect x="16" y="44" width="112" height="80" rx="8" className={BASE} />
      <rect x="16" y="44" width="112" height="80" rx="8" className={`fill-none ${LINE}`} strokeWidth="1.5" />
      <line x1="16" y1="64" x2="128" y2="64" className={LINE} strokeWidth="1.5" />
      <g className={DIM} opacity="0.6">
        <circle cx="28" cy="54" r="3" />
        <circle cx="38" cy="54" r="3" />
        <circle cx="48" cy="54" r="3" />
      </g>
      <path d="M62 82l24 24M86 82l-24 24" className={`${LINE} `} strokeWidth="2.5" strokeLinecap="round" />

      <path d="M144 84h26" className={ACCENT_LINE} strokeWidth="2" strokeLinecap="round" />
      <path d="M176 84l-9-5v10z" className={ACCENT} />

      {/* The render, carrying on. */}
      <rect x="192" y="40" width="112" height="40" rx="7" className={ACCENT_SOFT} />
      <rect x="192" y="40" width="112" height="40" rx="7" className={`fill-none ${ACCENT_LINE}`} strokeWidth="1.5" />
      <rect x="204" y="56" width="88" height="8" rx="4" className={DIM} opacity="0.35" />
      <rect x="204" y="56" width="58" height="8" rx="4" className={ACCENT} />

      {/* And the finished file, which belongs to one account. */}
      <rect x="192" y="96" width="112" height="64" rx="7" className={BASE} />
      <rect x="192" y="96" width="112" height="64" rx="7" className={`fill-none ${LINE}`} strokeWidth="1.5" />
      <path d="M230 128l8 8 18-18" className={`fill-none stroke-[var(--art-ok)]`} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="284" y="150" width="4" height="4" rx="2" className={OK} />
    </Frame>
  );
}

/**
 * In the order the claims are in the copy file, and that is the contract: the
 * list there and the drawings here are indexed against each other, so a claim
 * added without a drawing is a panel with a hole in it. The suite checks the
 * two lists are the same length rather than trusting the order to stay right.
 */
export const FEATURE_ART: ReadonlyArray<(rtl: boolean) => ReactElement> = [
  rawTakeBecomesPost,
  momentsFound,
  captionsInYourWords,
  looksEdited,
  finishesWithoutYou,
];
