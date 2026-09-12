/**
 * What the product does, one thing at a time, handed over by scrolling.
 *
 * The section this replaces was a column of five bullets beside a grid of four
 * drawings: everything the product does, all of it on screen at once, at the
 * size a bullet gets. Nothing was wrong with the claims — they are the same
 * claims here — but a list that long is read as a list, which means it is
 * skimmed and none of it lands.
 *
 * So the five get a screen each, and scrolling is what moves between them.
 *
 * ## It is a sticky section, not a hijacked scroll
 *
 * Those two look identical in a screen recording and are opposite things to
 * build. There is no wheel listener here, no `scrollTo`, nothing that overrides
 * the input: the section is simply *tall* — one viewport of height per feature
 * — and its contents are held still with `position: sticky` while that height
 * goes by. The page scrolls at exactly the speed the person scrolls it. What
 * changes as it does is which panel is drawn.
 *
 * The arithmetic that turns a scroll position into an index lives in
 * `lib/feature-scroll.ts` so that a suite can drive it through a page of scroll
 * positions without a browser. The edges are where this kind of thing is
 * quietly wrong — the last feature never reached, an index one past the end at
 * the bottom of the page — and they are cheap to check and invisible to look at.
 *
 * ## Three things the reference does not do
 *
 * **The names are buttons.** Inert names mean the only way to see the fourth
 * thing a product does is to scroll through the first three. Somebody who came
 * looking for one specific answer should be able to press it, and the page
 * scrolls itself to that slice — the one place a `scrollTo` belongs, because it
 * is a response to a click rather than a replacement for scrolling.
 *
 * **It says where you are.** A rail beside the list fills as the section goes
 * by, so the pin is legible rather than mysterious: you can see that five
 * screens are five screens and that they end.
 *
 * **It is a tab set.** `role="tablist"` and a panel with `role="tabpanel"`, so
 * the arrow keys work and a screen reader is told what the visual change means.
 * A scroll-driven picture that only exists for sighted mouse users is a section
 * a fifth of the audience cannot read.
 *
 * ## Where it stops being a good idea
 *
 * On a phone, and for anybody who has asked for less motion. A pinned section
 * on a 390px screen is a tall column of nothing with a small picture in it, and
 * five viewports of scroll to get past the part of the page that explains the
 * product. So below `md`, and whenever `prefers-reduced-motion` is set, there
 * is no pin at all: the five are five ordinary blocks, in order, and the page
 * scrolls the way the phone expects. Same words, same drawings, no mechanism.
 *
 * ## And the chip under each one is a real request
 *
 * The reference puts a `Try: "..."` line under each feature, and it is the best
 * idea on the page — for a product whose whole premise is that you type a
 * sentence, a feature *is* a sentence. Here it is not a label: every one of
 * those sentences is run through the product's own keyword planner by
 * `tools/feature-scroll-test.mjs`, in both languages, and pressing one carries
 * it into the app with the sentence already written. A prompt on a landing page
 * that the product would not understand is the most embarrassing kind of lie
 * available to us, and it is one check away from impossible.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useLocation } from "wouter";
import { ArrowRight } from "lucide-react";
import { useLanguage } from "@/lib/language";
import { LANDING } from "@/lib/landing-copy";
import { activeFromRect, scrollTopForIndex } from "@/lib/feature-scroll";
import { FEATURE_ART } from "@/components/feature-art";

/**
 * How many viewports of scroll each feature gets.
 *
 * One, and it is a number worth defending. Less and the section flicks between
 * panels faster than the crossfade can finish, which reads as a glitch rather
 * than as a change. More and the page feels stuck: the commonest complaint
 * about this pattern everywhere it appears is that a section would not let go,
 * and that is always somebody spending three viewports per item.
 */
const VIEWPORTS_PER_FEATURE = 1;

/** Milliseconds. Long enough to read as a change, short enough not to lag the scroll. */
const CROSSFADE_MS = 380;

export function FeatureScroller() {
  const { t, language } = useLanguage();
  const rtl = language === "ar";
  const [, setLocation] = useLocation();
  const sectionRef = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState(0);
  const [pinned, setPinned] = useState(false);

  const items = useMemo(
    () =>
      LANDING.features.list.map((entry, index) => ({
        index,
        title: t(entry.title),
        detail: t(entry.detail),
        prompt: t(entry.prompt),
        art: FEATURE_ART[index],
      })),
    [t],
  );
  const count = items.length;

  /*
    Whether the pin runs at all.

    Read once on mount and kept current, rather than baked in at build time,
    because both answers can change while the page is open: a window is resized
    across the breakpoint, and the motion preference is a live media query on
    every platform that has one.
  */
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 768px)");
    const still = window.matchMedia("(prefers-reduced-motion: reduce)");
    const decide = () => setPinned(wide.matches && !still.matches);
    decide();
    wide.addEventListener("change", decide);
    still.addEventListener("change", decide);
    return () => {
      wide.removeEventListener("change", decide);
      still.removeEventListener("change", decide);
    };
  }, []);

  /*
    The only thing this listens to, and it listens passively.

    One `scroll` handler that does nothing but read a rectangle and set an
    integer, coalesced to one read per frame. `passive: true` is what keeps it
    out of the way of the scroll itself: a non-passive scroll listener makes the
    browser wait for JavaScript before it will move the page, which is precisely
    the stutter this pattern is blamed for.
  */
  useEffect(() => {
    if (!pinned) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const node = sectionRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      setActive(activeFromRect({ top: rect.top, height: rect.height, viewport: window.innerHeight }, count));
    };
    const onScroll = () => {
      if (frame === 0) frame = window.requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [pinned, count]);

  /** A press on a name: the one `scrollTo` that belongs here. See the file's note. */
  const goTo = useCallback(
    (index: number) => {
      const node = sectionRef.current;
      if (!node || !pinned) {
        setActive(index);
        return;
      }
      const rect = node.getBoundingClientRect();
      window.scrollTo({
        top: scrollTopForIndex(index, count, {
          sectionTop: rect.top + window.scrollY,
          height: rect.height,
          viewport: window.innerHeight,
        }),
        behavior: "smooth",
      });
    },
    [count, pinned],
  );

  /* Left and right move between features, which is what a tab list promises. */
  const onKeyDown = (event: React.KeyboardEvent) => {
    const forward = rtl ? "ArrowLeft" : "ArrowRight";
    const back = rtl ? "ArrowRight" : "ArrowLeft";
    if (event.key === forward || event.key === "ArrowDown") {
      event.preventDefault();
      goTo(Math.min(count - 1, active + 1));
    } else if (event.key === back || event.key === "ArrowUp") {
      event.preventDefault();
      goTo(Math.max(0, active - 1));
    }
  };

  const ask = (prompt: string) => {
    /*
      To the screen that opens a text box, with the sentence already in it.

      `/onboarding` and not `/dashboard`: the dashboard is a grid of projects,
      and arriving there having just pressed a sentence would be the product
      forgetting the sentence. The first-run screen asks the two questions this
      answers half of - which file, and what should happen to it - and
      `askedSentence` reads the half that is already answered out of the URL.

      In the URL rather than in memory, because this is a public page: whoever
      presses it may well not be signed in, and `Protected` sends them through
      a login that reloads the app. Anything held in a module would be gone;
      the query string rides along in `?next=`.
    */
    setLocation(`/onboarding?ask=${encodeURIComponent(prompt)}`);
  };

  /*
    No `.reveal` anywhere in this component, and that is a fix rather than a
    preference.

    The page's reveal is one `IntersectionObserver` set up in `home.tsx`, which
    queries `.reveal` **once, at mount**, and hands the class `visible` to what
    it finds. `.reveal` alone is `opacity: 0`. This component's markup does not
    exist at that moment - `pinned` is decided in an effect, so the first paint
    is the stacked branch and the pinned one is built a frame later, and it is
    rebuilt again whenever the window crosses the `md` breakpoint. Anything in
    here wearing `.reveal` is therefore invisible, permanently, with no error
    and nothing in the DOM to suggest a heading was ever meant to be there.

    It was: the eyebrow, the title and the lead were all `.reveal`, and the
    section rendered with a blank strip above it where they should have been.
  */
  const header = (
    <div className="mb-12 sm:mb-16 max-w-2xl">
      <p className="text-primary text-sm font-semibold tracking-widest uppercase mb-3">
        {t(LANDING.features.eyebrow)}
      </p>
      <h2 className="text-4xl font-bold leading-tight">{t(LANDING.features.title)}</h2>
      <p className="text-muted-foreground mt-4 leading-relaxed">{t(LANDING.features.lead)}</p>
    </div>
  );

  /*
    No pin: five blocks, in order.

    Not a degraded version of the pinned one — the same words and the same
    drawings, laid out the way a phone reads. The mechanism is what is missing,
    and the mechanism was never the content.
  */
  if (!pinned) {
    return (
      <section id="features" ref={sectionRef} className="relative w-full max-w-7xl mx-auto px-6 pt-24 pb-20 sm:pt-32">
        {header}
        <ol className="space-y-14" data-testid="features-stacked">
          {items.map((item) => (
            <li key={item.title}>
              <div className="flex items-baseline gap-3">
                <span className="text-xs font-semibold text-muted-foreground tabular-nums" dir="ltr">
                  {String(item.index + 1).padStart(2, "0")}
                </span>
                <h3 className="text-2xl font-semibold leading-tight">{item.title}</h3>
              </div>
              <FeaturePanel item={item} rtl={rtl} onAsk={ask} tryLabel={t(LANDING.features.tryIt)} />
            </li>
          ))}
        </ol>
      </section>
    );
  }

  return (
    <section
      id="features"
      ref={sectionRef}
      className="relative w-full"
      style={{ height: `calc(${count * VIEWPORTS_PER_FEATURE} * 100vh + 100vh)` }}
    >
      {/* `top-0 h-screen` and the header inside it: the whole composition is
          held still together, so the eyebrow does not scroll away and leave the
          list looking like it belongs to whatever came before. */}
      <div className="sticky top-0 h-screen flex items-center overflow-hidden">
        <div className="w-full max-w-7xl mx-auto px-6">
          {header}
          <div className="grid md:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)] gap-10 lg:gap-16 items-start">
            {/* The names, and the rail that says how far through they are. */}
            <div className="flex gap-5">
              {/* Two pixels, not one. A hairline is the right weight for a
                  divider and the wrong weight for a thing that is meant to be
                  read: at 1px the filled part and the empty part are the same
                  mark to anyone not looking for the difference, which makes the
                  one piece of state on this section invisible. */}
              <div className="relative w-0.5 rounded-full bg-hairline shrink-0 my-1" aria-hidden="true">
                <div
                  className="absolute inset-x-0 top-0 bg-primary rounded-full transition-[height] duration-500 ease-out"
                  style={{ height: `${((active + 1) / count) * 100}%` }}
                />
              </div>
              <ol
                role="tablist"
                aria-label={t(LANDING.features.eyebrow)}
                onKeyDown={onKeyDown}
                className="flex-1 min-w-0"
                data-testid="features-list"
              >
                {items.map((item) => {
                  const current = item.index === active;
                  return (
                    <li key={item.title}>
                      <button
                        type="button"
                        role="tab"
                        id={`feature-tab-${item.index}`}
                        aria-selected={current}
                        aria-controls="feature-panel"
                        tabIndex={current ? 0 : -1}
                        onClick={() => goTo(item.index)}
                        data-testid={`feature-tab-${item.index}`}
                        className="group w-full text-start flex items-baseline gap-3 py-2.5 min-h-11 md:min-h-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                      >
                        <span
                          dir="ltr"
                          className={`text-[11px] font-semibold tabular-nums transition-colors duration-300 ${
                            current ? "text-primary" : "text-muted-foreground/50"
                          }`}
                        >
                          {String(item.index + 1).padStart(2, "0")}
                        </span>
                        <span
                          className={`text-xl lg:text-2xl font-semibold leading-snug transition-colors duration-300 ${
                            current ? "text-foreground" : "text-muted-foreground/45 group-hover:text-muted-foreground"
                          }`}
                        >
                          {item.title}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>

            {/* One panel, crossfaded. Every feature's markup is mounted so the
                drawings do not have to be built again on every change, and only
                the current one is opaque and reachable. */}
            <div className="relative" id="feature-panel" role="tabpanel" aria-labelledby={`feature-tab-${active}`}>
              {items.map((item) => (
                <div
                  key={item.title}
                  aria-hidden={item.index !== active}
                  data-testid={`feature-panel-${item.index}`}
                  className={
                    item.index === active
                      ? "transition-opacity ease-out opacity-100"
                      : "absolute inset-0 pointer-events-none transition-opacity ease-out opacity-0"
                  }
                  style={{ transitionDuration: `${CROSSFADE_MS}ms` }}
                >
                  <FeaturePanel item={item} rtl={rtl} onAsk={ask} tryLabel={t(LANDING.features.tryIt)} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

interface PanelItem {
  index: number;
  title: string;
  detail: string;
  prompt: string;
  art: (rtl: boolean) => ReactElement;
}

function FeaturePanel({
  item,
  rtl,
  onAsk,
  tryLabel,
}: {
  item: PanelItem;
  rtl: boolean;
  onAsk: (prompt: string) => void;
  tryLabel: string;
}) {
  return (
    <div className="mt-4">
      {/* `aspect-[16/10]` rather than a height: the drawing is the same shape
          at every width, so nothing inside it has to be re-laid-out and a
          narrow window cannot crop it. */}
      <div className="glass-panel glass-flat rounded-2xl overflow-hidden aspect-[16/10] p-4 sm:p-6">
        {item.art(rtl)}
      </div>
      <p className="text-muted-foreground leading-relaxed mt-5">{item.detail}</p>
      <button
        type="button"
        onClick={() => onAsk(item.prompt)}
        data-testid={`feature-prompt-${item.index}`}
        className="aura-chip no-default-hover-elevate group mt-4 rounded-full min-h-11 px-4 inline-flex items-center gap-2 max-w-full"
      >
        <span className="text-xs text-muted-foreground shrink-0">{tryLabel}</span>
        <span dir="auto" className="text-sm font-medium truncate min-w-0">
          {`“${item.prompt}”`}
        </span>
        <ArrowRight className="w-3.5 h-3.5 shrink-0 transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5 rtl:rotate-180" />
      </button>
    </div>
  );
}
