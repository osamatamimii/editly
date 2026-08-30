import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Play, Sparkles, Zap, CheckCircle2, ArrowRight, Check, Upload, MessageSquareText, Send, ChevronLeft, Download } from "lucide-react";
import { useGetSubscription, useUpdateSubscription, getGetSubscriptionQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { fetchCheckoutConfig, openCheckout } from "@/lib/checkout";
import { useAuth } from "@/lib/auth";
import { Logo } from "@/components/logo";
import { PLANS, SHARED_FEATURES, FREE_TIER } from "@/lib/pricing";

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
function HeroEditor({ phone }: { phone: boolean }) {
  return (
    // `text-left` because the hero section around this is centred, and an app
    // whose every label is centred does not read as an app.
    <div className="force-dark text-left rounded-xl overflow-hidden relative bg-[#0a090b] text-[#efeaf7]">
      {/* Title bar */}
      <div className="flex items-center gap-3 px-4 sm:px-5 h-12 sm:h-14 border-b border-white/[0.07] bg-white/[0.02]">
        <ChevronLeft className="w-4 h-4 text-white/35 flex-shrink-0" />
        <p className="text-[13px] sm:text-[15px] font-semibold truncate">Podcast episode 14</p>
        <span className="hidden sm:inline-flex text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-400/15 text-emerald-300 border border-emerald-400/25 flex-shrink-0">
          done
        </span>
        <div className="ml-auto flex items-center gap-2 flex-shrink-0">
          <span className="hidden sm:flex items-center gap-1.5 text-[13px] text-white/60 px-3 py-1.5 rounded-lg border border-white/10">
            <Download className="w-3.5 h-3.5" /> Export
          </span>
          <span className="flex items-center gap-1.5 text-[12px] sm:text-[13px] font-semibold text-white px-3 py-1.5 rounded-lg bg-[#6c3bff] shadow-[0_0_20px_rgba(108,59,255,0.45)]">
            <Sparkles className="w-3.5 h-3.5" /> Generate Edit
          </span>
        </div>
      </div>

      <div className="grid md:grid-cols-[minmax(0,0.92fr)_minmax(0,1fr)]">
        {/* ── What went in ── */}
        <div className="p-4 sm:p-5 md:border-r border-white/[0.07] flex flex-col gap-3">
          <p className="text-[12px] sm:text-[11px] uppercase tracking-[0.14em] text-white/35 font-semibold">
            The raw take
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
                  <stop offset="0" stopColor="#241b45" />
                  <stop offset="0.58" stopColor="#171130" />
                  <stop offset="1" stopColor="#0d181c" />
                </linearGradient>
                <radialGradient id="hero-lamp" cx="0.64" cy="0.3" r="0.55">
                  <stop offset="0" stopColor="#8b5cf6" stopOpacity="0.5" />
                  <stop offset="1" stopColor="#8b5cf6" stopOpacity="0" />
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
              <g className="fill-[#cdbcff]" opacity="0.62">
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
            <div className="absolute bottom-2 left-2 text-[12px] sm:text-[10px] font-mono text-white/45 bg-black/45 px-1.5 py-0.5 rounded">
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
                  className={h > 2 ? "fill-[#8b5cf6]" : "fill-white/15"}
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
              4 silences found · <span className="text-white/70">5.8s</span> of dead air
            </p>
          </div>
        </div>

        {/* ── What was asked, and what came back ── */}
        <div className="p-4 sm:p-5 flex flex-col gap-3">
          <div className="flex justify-end">
            <p className="max-w-[85%] text-[12px] sm:text-[13.5px] leading-relaxed rounded-2xl rounded-br-sm px-3.5 py-2.5 bg-[#6c3bff] text-white">
              Cut the dead air and make it vertical for TikTok
            </p>
          </div>

          <div className="flex items-start gap-2.5">
            <span className="w-7 h-7 rounded-full bg-[#6c3bff]/25 border border-[#6c3bff]/40 flex items-center justify-center flex-shrink-0">
              <Sparkles className="w-3.5 h-3.5 text-[#a78bfa]" />
            </span>
            <div className="min-w-0">
              <p className="text-[12px] sm:text-[11px] font-semibold text-white/50 mb-1.5">Noah</p>
              <p className="text-[12px] sm:text-[13.5px] leading-relaxed text-white/80 mb-2.5">
                Here is what I will do, before I do it:
              </p>
              {/* The plan, itemised. This is the promise the product makes:
                  you see the edit described before it is rendered. */}
              <ul className="flex flex-col gap-1.5">
                {[
                  "Cut every silence longer than 0.4s",
                  "Reframe to 9:16, keeping you in frame",
                  "Burn in captions from what you said",
                  "Level the audio to −14 LUFS",
                ].map((line) => (
                  <li key={line} className="flex items-start gap-2 text-[12px] sm:text-[13px] leading-snug text-white/70">
                    <Check className="w-3.5 h-3.5 text-emerald-400 mt-0.5 flex-shrink-0" />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* What came out, beside the numbers that describe it. */}
          <div className="mt-1 flex items-stretch gap-3 rounded-xl border border-[#6c3bff]/30 bg-[#6c3bff]/[0.07] p-3">
            <div className="w-[62px] sm:w-[72px] flex-shrink-0 rounded-md overflow-hidden border-2 border-[#6c3bff]/60">
              {/* The same room, cropped to 9:16 and centred on the speaker,
                  with the captions on the picture rather than beside it. */}
              <svg viewBox="0 0 62 110" className="w-full h-auto block" aria-hidden="true">
                <rect width="62" height="110" fill="url(#hero-room)" />
                <rect width="62" height="110" fill="url(#hero-lamp)" />
                <g className="fill-[#cdbcff]" opacity="0.68">
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
                Done. 12.3s became 6.5s.
              </p>
              <p className="text-[12px] leading-snug text-white/55">
                1080×1920 for TikTok · 4 captions burned in · levelled to −14 LUFS
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const sectionsRef = useScrollReveal();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const subscriptionQuery = useGetSubscription({
    query: { queryKey: getGetSubscriptionQueryKey() }
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
   */
  const planKnown = subscriptionQuery.data !== undefined;
  const currentPlan = (subscription?.plan ?? "free") as keyof typeof RANK;
  const updateSubscription = useUpdateSubscription();

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
      updateSubscription.mutate(
        { data: { plan } },
        { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetSubscriptionQueryKey() }) }
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

  /* The landing page paints the document, not just its own subtree — see the
     note on the wrapper below. Scoped to the mount so /app keeps its theme. */
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.pageTheme = "light";
    return () => {
      delete root.dataset.pageTheme;
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
    <div
      className="light w-full flex flex-col items-center bg-background text-foreground"
      style={{ colorScheme: "light" }}
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
      <header className="w-full max-w-7xl mx-auto px-4 sm:px-6 py-5 sm:py-6 flex items-center justify-between gap-2 z-10 relative animate-fade-in">
        <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
          <Logo className="w-8 h-8 sm:w-9 sm:h-9 text-brand-mark flex-shrink-0" />
          <span className="font-bold text-lg sm:text-xl tracking-tight">Editly</span>
        </div>
        <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-muted-foreground">
          {["Features", "How it works", "Pricing"].map((item) => (
            <a
              key={item}
              href={`#${item.toLowerCase().replace(/ /g, "-")}`}
              className="relative hover:text-foreground transition-colors group"
            >
              {item}
              <span className="absolute -bottom-0.5 left-0 w-0 h-px bg-primary transition-all duration-300 group-hover:w-full" />
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
        <div className="flex items-center gap-1.5 sm:gap-3">
          {/* The theme control is gone from this page, with the theme. It
              lives in the app, on the screens where somebody sits long enough
              for it to matter. */}
          {user ? (
            <Link
              href="/dashboard"
              data-testid="link-dashboard"
              className="glow-btn btn-gradient-cta text-white px-5 sm:px-6 min-h-[44px] inline-flex items-center rounded-full font-medium whitespace-nowrap animate-shimmer-border border border-transparent"
            >
              Dashboard
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                data-testid="link-log-in"
                className="px-3 sm:px-4 min-h-[44px] inline-flex items-center rounded-full font-medium text-sm whitespace-nowrap text-muted-foreground hover:text-foreground hover:bg-surface-1 transition-colors"
              >
                Log in
              </Link>
              <Link
                href="/login?mode=signup"
                data-testid="link-sign-up"
                className="glow-btn btn-gradient-cta text-white px-4 sm:px-6 min-h-[44px] inline-flex items-center rounded-full font-medium text-sm sm:text-base whitespace-nowrap animate-shimmer-border border border-transparent"
              >
                <span className="sm:hidden">Sign up</span>
                <span className="hidden sm:inline">Sign up free</span>
              </Link>
            </>
          )}
        </div>
      </header>

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
        <div
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-surface-1 border border-hairline mb-8 backdrop-blur-md animate-fade-up"
          style={{ animationDelay: "100ms" }}
        >
          <Sparkles className="w-4 h-4 text-secondary animate-sparkle" />
          {/* Introduces the person the headline tells you to describe to, and
              claims nothing we have not built: no version number, nothing that
              reads as "we shipped a model". The result is one line further down,
              where it has room to be specific. */}
          <span className="text-sm font-medium text-foreground/80">Meet Noah. Tell him what you want</span>
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
          <span className="glow-text">Stop editing.</span>
          <br />
          <span
            className="headline-serif animate-gradient-shift"
            style={{
              background: "linear-gradient(135deg, #6C3BFF 0%, #9B6BFF 40%, #c084fc 70%, #6C3BFF 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
              backgroundSize: "200% 200%",
            }}
          >
            Start describing.
          </span>
        </h1>

        {/* Subtext */}
        <p
          className="text-lg md:text-xl text-muted-foreground mb-12 max-w-2xl animate-fade-up"
          style={{ animationDelay: "320ms" }}
        >
          Upload the raw take. Describe the edit. Get three hours of your evening
          back, on every video.
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
            className="glow-btn btn-gradient-cta flex items-center justify-center gap-2 text-white h-14 px-8 rounded-full font-semibold text-lg"
          >
            <Play className="w-5 h-5 fill-current" />
            {user ? "Upload a raw take" : "Start editing free"}
          </Link>
          {/* This said "Watch Demo" and had no handler at all — the second
              largest thing on the page did nothing when pressed, and there is
              no demo film to play even if it had. What the page does have is
              the three steps further down, so the button goes there. A button
              that scrolls is worth more than a button that lies. */}
          <a
            href="#how-it-works"
            data-testid="link-hero-secondary"
            className="group flex items-center justify-center gap-2 h-14 px-8 rounded-full font-semibold text-lg bg-surface-1 hover:bg-surface-1 border border-hairline transition-all duration-300 hover:border-primary/40 hover:shadow-[0_0_24px_rgba(108,59,255,0.2)] backdrop-blur-sm"
          >
            See how it works
            <ArrowRight className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-1" />
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
                "0 40px 80px rgba(108,59,255,0.28), 0 80px 160px rgba(108,59,255,0.10), 0 0 0 1px rgba(155,107,255,0.12)",
            }}
          >
            <HeroEditor phone={phone} />
          </div>
          <p className="mt-4 text-xs sm:text-sm text-muted-foreground text-center">
            One real edit: 12.3 seconds in, 6.5 out. Every number here is one the
            renderer produced.
          </p>
        </div>
      </section>

      {/* ── How It Works ── */}
      <section id="how-it-works" className="w-full bg-band py-24 relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(108,59,255,0.08)_0%,transparent_60%)]" />
        <div className="max-w-7xl mx-auto px-6 relative z-10">
          <div className="text-center mb-16">
            <div className="reveal">
              <p className="text-primary text-sm font-semibold tracking-widest uppercase mb-3">How it works</p>
              <h2 className="text-3xl md:text-4xl font-bold mb-4">Three steps, none of them tedious</h2>
              <p className="text-muted-foreground text-lg">The part you dread, done while you are not looking.</p>
            </div>
          </div>

          {/* Each step is drawn, not screenshotted.
              These were three crops of the demo recording: a dark rectangle
              each, two of them cropped so hard the text inside was a few pixels
              tall and unreadable, on a page that is otherwise light. A picture
              of a screen at that size carries nothing — you cannot read it, so
              all it says is "there is a screen". Each card now draws the step
              itself at the size it is shown, in the same ink as the feature
              grid: the take arriving with its dead air still in it, the
              sentence and the plan it produced, and the vertical cut that came
              out. No stock, no screenshots, and nothing that can go stale when
              the app's chrome changes. */}
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                num: "01",
                icon: Upload,
                title: "Upload the raw take",
                desc: "The unedited one, with all the ums and restarts still in it. That is the point.",
                delay: "0ms",
                art: (
                  <svg viewBox="0 0 320 180" className="w-full h-full" aria-hidden="true">
                    <rect x="20" y="18" width="280" height="144" rx="12" className="fill-none stroke-[var(--art-line)]" strokeWidth="2" strokeDasharray="8 7" />
                    <rect x="44" y="42" width="232" height="96" rx="10" className="fill-[var(--art-base)]" />
                    <rect x="44" y="42" width="232" height="96" rx="10" className="fill-none stroke-[var(--art-line)]" strokeWidth="1.5" />
                    <text x="62" y="68" className="fill-[var(--art-accent)]" fontSize="13" fontWeight="600" fontFamily="ui-monospace, monospace">raw-take.mov</text>
                    <text x="258" y="68" textAnchor="end" className="fill-[var(--art-line)]" fontSize="12" fontFamily="ui-monospace, monospace">12:04</text>
                    {/* The take, with the dead air still in it — flat where
                        nobody is talking, which is what step three removes. */}
                    <g>
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
                  </svg>
                ),
              },
              {
                num: "02",
                icon: MessageSquareText,
                title: "Say what you want",
                desc: "\"Cut the dead air and make it vertical for TikTok.\" Editly tells you exactly what it will do before it does it.",
                delay: "120ms",
                art: (
                  <svg viewBox="0 0 320 180" className="w-full h-full" aria-hidden="true">
                    {/* What you typed, */}
                    <rect x="78" y="18" width="226" height="48" rx="12" className="fill-[var(--art-accent-soft)]" />
                    <rect x="78" y="18" width="226" height="48" rx="12" className="fill-none stroke-[var(--art-accent)]" strokeWidth="1.5" />
                    <text x="94" y="39" className="fill-[var(--art-accent)]" fontSize="11.5" fontWeight="600">Cut the dead air and make it</text>
                    <text x="94" y="56" className="fill-[var(--art-accent)]" fontSize="11.5" fontWeight="600">vertical for TikTok.</text>
                    {/* and what it says back, before it starts. */}
                    <circle cx="34" cy="98" r="12" className="fill-[var(--art-accent-soft)]" />
                    <path d="M28 98l4.5 4.5L40 94" className="fill-none stroke-[var(--art-accent)]" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    {[
                      { y: 84, w: 162, t: "Remove 41s of silence" },
                      { y: 114, w: 124, t: "Reframe to 9:16" },
                      { y: 144, w: 158, t: "Burn in your captions" },
                    ].map((row) => (
                      <g key={row.y}>
                        <rect x="56" y={row.y} width={row.w} height="28" rx="14" className="fill-[var(--art-base)]" />
                        <rect x="56" y={row.y} width={row.w} height="28" rx="14" className="fill-none stroke-[var(--art-line)]" strokeWidth="1.5" />
                        <text x="72" y={row.y + 19} className="fill-[var(--art-accent)]" fontSize="11.5">{row.t}</text>
                      </g>
                    ))}
                  </svg>
                ),
              },
              {
                num: "03",
                icon: Send,
                title: "Post it",
                desc: "Framed for TikTok, Reels or Shorts, and waiting for you when you come back.",
                delay: "240ms",
                art: (
                  <svg viewBox="0 0 320 180" className="w-full h-full" aria-hidden="true">
                    {/* The widescreen you shot, with the speaker sitting off
                        to one side of it the way a phone on a desk films you, */}
                    <rect x="22" y="34" width="184" height="104" rx="8" className="fill-[var(--art-base)]" />
                    <rect x="22" y="34" width="184" height="104" rx="8" className="fill-none stroke-[var(--art-line)]" strokeWidth="1.5" strokeDasharray="6 5" />
                    <circle cx="138" cy="74" r="17" className="fill-none stroke-[var(--art-line)]" strokeWidth="2" />
                    <path d="M120 116a18 18 0 0 1 36 0" className="fill-none stroke-[var(--art-line)]" strokeWidth="2" />
                    <text x="22" y="158" className="fill-[var(--art-line)]" fontSize="11" fontFamily="ui-monospace, monospace">16:9 source</text>
                    {/* and the vertical it kept, centred on them, with the
                        words burned onto it. */}
                    <rect x="104" y="16" width="94" height="148" rx="10" className="fill-[var(--art-accent-soft)]" />
                    <rect x="104" y="16" width="94" height="148" rx="10" className="fill-none stroke-[var(--art-accent)]" strokeWidth="2.5" />
                    <circle cx="151" cy="66" r="19" className="fill-none stroke-[var(--art-accent)]" strokeWidth="2.5" />
                    <path d="M131 112a20 20 0 0 1 40 0" className="fill-none stroke-[var(--art-accent)]" strokeWidth="2.5" />
                    <path d="M126 132h50M138 146h26" className="stroke-[var(--art-accent)]" strokeWidth="7" strokeLinecap="round" />
                    <text x="216" y="90" className="fill-[var(--art-accent)]" fontSize="12" fontWeight="700" fontFamily="ui-monospace, monospace">9:16</text>
                    <path d="M216 100h30" className="stroke-[var(--art-accent)]" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                ),
              },
            ].map((step) => (
              <div
                key={step.num}
                className="reveal glass-panel glass-flat rounded-2xl relative overflow-hidden group cursor-default transition-all duration-500 hover:border-primary/30 hover:shadow-[0_0_40px_rgba(108,59,255,0.2)] hover:-translate-y-1 flex flex-col"
                style={{ transitionDelay: step.delay }}
              >
                <div className="relative bg-band border-b border-hairline-faint h-52 sm:h-56 overflow-hidden flex items-center justify-center p-5">
                  {step.art}
                  <span className="absolute top-3 left-3 text-xs font-mono font-semibold text-muted-foreground bg-surface-1 px-2 py-1 rounded-md border border-hairline-faint">
                    {step.num}
                  </span>
                </div>
                <div className="p-6 sm:p-8 pt-6 flex-1">
                  <div className="w-10 h-10 rounded-xl bg-primary/20 border border-primary/30 flex items-center justify-center mb-4 group-hover:shadow-[0_0_15px_rgba(108,59,255,0.5)] transition-shadow">
                    <step.icon className="w-5 h-5 text-primary" />
                  </div>
                  <h3 className="text-xl font-bold mb-3">{step.title}</h3>
                  <p className="text-muted-foreground leading-relaxed">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section id="features" className="w-full max-w-7xl mx-auto px-6 py-24">
        <div className="grid md:grid-cols-2 gap-16 items-center">
          <div>
            <div className="reveal">
              <p className="text-primary text-sm font-semibold tracking-widest uppercase mb-3">Features</p>
              <h2 className="text-4xl font-bold mb-6 leading-tight">What it does today</h2>
            </div>
            {/* Five outcomes, not eleven mechanics.
                This was a checklist of everything the renderer can do, one
                switch per line — and a list that long is read as a list, which
                means it is skimmed and none of it lands. Nothing has been
                dropped from the product: each line here is the result, with the
                mechanics that produce it underneath, where they belong. Still
                kept honest by hand: everything named works today. */}
            <ul className="space-y-6">
              {[
                {
                  title: "A raw take becomes a post",
                  detail:
                    "Every silence and pause cut, framed for TikTok, Reels and Shorts (or YouTube, or square), and the levels fixed. From one sentence.",
                },
                {
                  title: "The moments worth keeping, found for you",
                  detail:
                    "The strongest thirty seconds of a long take, or the whole thing cut into separate clips, each titled by what the speaker actually said. Open any of them and keep editing.",
                },
                {
                  title: "Captions in your own words",
                  detail:
                    "Burned in from what you said, not from a template. In English or Arabic, laid out in the direction that language reads.",
                },
                {
                  title: "It looks edited, not processed",
                  detail:
                    "Dissolves between the cuts, your own music ducking out of the way while you talk, and a grade: warm, cinematic, or matched to a clip whose colour you liked.",
                },
                {
                  title: "It finishes without you",
                  detail:
                    "Close the tab and the render carries on. Your footage stays private to your account.",
                },
              ].map((feat, i) => (
                <li
                  key={feat.title}
                  className="reveal flex items-start gap-4 group"
                  style={{ transitionDelay: `${i * 80}ms` }}
                >
                  <div className="w-9 h-9 mt-0.5 flex-shrink-0 rounded-full bg-primary/15 flex items-center justify-center border border-primary/30 shadow-[0_0_8px_rgba(108,59,255,0.2)] group-hover:shadow-[0_0_16px_rgba(108,59,255,0.5)] group-hover:border-primary/60 transition-all duration-300">
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
                Try it yourself
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
            <div className="glass-panel glass-flat p-4 sm:p-6 rounded-2xl relative z-10 transition-all duration-500 hover:shadow-[0_0_60px_rgba(108,59,255,0.2)]">
              <div className="grid grid-cols-2 gap-3 sm:gap-4">
                {[
                  {
                    label: "B-roll",
                    hint: "cut in over the take",
                    art: (
                      <svg viewBox="0 0 120 120" className="w-full h-full" aria-hidden="true">
                        <rect x="10" y="24" width="76" height="52" rx="6" className="fill-[var(--art-base)]" />
                        <rect x="10" y="24" width="76" height="52" rx="6" className="fill-none stroke-[var(--art-line)]" strokeWidth="1.5" />
                        {/* The cutaway, lifted off the shot beneath it. */}
                        <rect x="46" y="44" width="64" height="46" rx="6" className="fill-[var(--art-accent-soft)]" />
                        <rect x="46" y="44" width="64" height="46" rx="6" className="fill-none stroke-[var(--art-accent)]" strokeWidth="2" />
                        <path d="M62 60l18 9-18 9z" className="fill-[var(--art-accent)]" />
                      </svg>
                    ),
                  },
                  {
                    label: "Dead air",
                    hint: "cut, not trimmed by hand",
                    accent: true,
                    art: (
                      <svg viewBox="0 0 120 120" className="w-full h-full" aria-hidden="true">
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
                      </svg>
                    ),
                  },
                  {
                    label: "Captions",
                    hint: "from what you said",
                    art: (
                      <svg viewBox="0 0 120 120" className="w-full h-full" aria-hidden="true">
                        <rect x="14" y="18" width="92" height="84" rx="8" className="fill-[var(--art-base)]" />
                        <rect x="14" y="18" width="92" height="84" rx="8" className="fill-none stroke-[var(--art-line)]" strokeWidth="1.5" />
                        {/* Filled, then half-filled, then waiting — the wipe. */}
                        <rect x="26" y="62" width="34" height="10" rx="5" className="fill-[var(--art-accent)]" />
                        <rect x="64" y="62" width="30" height="10" rx="5" className="fill-[var(--art-line)]" />
                        <rect x="64" y="62" width="13" height="10" rx="5" className="fill-[var(--art-accent)]" />
                        <rect x="26" y="78" width="46" height="10" rx="5" className="fill-[var(--art-line)]" />
                      </svg>
                    ),
                  },
                  {
                    label: "Transitions",
                    hint: "dissolved, not dropped",
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
                        <rect x="8" y="34" width="70" height="52" rx="6" fill="url(#dissolve-a)" />
                        <rect x="42" y="34" width="70" height="52" rx="6" fill="url(#dissolve-b)" />
                        <rect x="8" y="34" width="104" height="52" rx="6" className="fill-none stroke-[var(--art-line)]" strokeWidth="1.5" />
                      </svg>
                    ),
                  },
                ].map((cell, i) => (
                  <div
                    key={i}
                    className={`aspect-square rounded-xl overflow-hidden border transition-all duration-300 cursor-default flex flex-col
                      ${cell.accent
                        ? "bg-primary/15 border-primary/40 shadow-[0_0_20px_rgba(108,59,255,0.18)] hover:shadow-[0_0_35px_rgba(108,59,255,0.4)]"
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

      {/* ── Pricing ── */}
      <section id="pricing" className="w-full max-w-7xl mx-auto px-6 py-24">
        <div className="text-center mb-10 reveal">
          {/* A step down from the other section headings, and balanced: this
              line is longer than they are, and at 5xl it wrapped with a single
              word stranded on the second line. */}
          <h2 className="text-3xl md:text-4xl font-bold mb-4 glow-text max-w-3xl mx-auto text-balance">
            Priced by the minutes you publish, not the hours you record
          </h2>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto">
            Every plan does the same editing. Upload as much footage as you like.
          </p>
        </div>

        {/* Billing toggle */}
        <div className="flex justify-center mb-10">
          <div className="inline-flex items-center gap-1 p-1 rounded-full bg-surface-1 border border-hairline backdrop-blur-sm">
            <button
              onClick={() => setIsYearly(false)}
              className={`px-6 min-h-[44px] rounded-full text-sm font-medium transition-all duration-300 ${
                !isYearly
                  ? "bg-primary text-white shadow-[0_0_16px_rgba(108,59,255,0.5)]"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setIsYearly(true)}
              className={`flex items-center justify-center gap-2 px-6 min-h-[44px] rounded-full text-sm font-medium transition-all duration-300 ${
                isYearly
                  ? "bg-primary text-white shadow-[0_0_16px_rgba(108,59,255,0.5)]"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Yearly
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border transition-all duration-300 ${
                isYearly
                  ? "bg-surface-3 text-foreground border-hairline-strong"
                  : "bg-primary/15 text-primary border-primary/30"
              }`}>
                Save 20%
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
            <div className="text-sm font-semibold text-primary">{FREE_TIER.headline}</div>
            <div className="text-3xl font-bold mt-1">
              $0<span className="text-base font-medium text-muted-foreground">/month</span>
            </div>
          </div>
          <ul className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
            {FREE_TIER.lines.map((line) => (
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
                    ? "border-primary/60 shadow-[0_0_50px_rgba(108,59,255,0.25)] bg-surface-2"
                    : "border-hairline bg-surface-1 hover:border-hairline-strong"
                }`}
                style={{
                  transitionDelay: `${i * 80}ms`,
                  boxShadow: isPro
                    ? "inset 0 1px 0 rgba(255,255,255,0.1), 0 0 50px rgba(108,59,255,0.25)"
                    : "inset 0 1px 0 rgba(255,255,255,0.05)",
                }}
              >
                {isPro && (
                  <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent" />
                )}
                {isPro && (
                  <div className="absolute top-4 right-4">
                    <span className="text-xs font-bold uppercase tracking-widest px-3 py-1 rounded-full bg-primary/20 text-primary border border-primary/30">
                      Most Popular
                    </span>
                  </div>
                )}

                <div className="p-8 flex flex-col flex-1">
                  <div className="mb-6">
                    <h3 className="text-xl font-bold mb-1">{plan.name}</h3>
                    <div className="mt-3 transition-all duration-300">
                      <div className="flex items-baseline gap-1">
                        <span className="text-4xl font-bold transition-all duration-300">
                          ${isYearly ? plan.yearlyPrice : plan.price}
                        </span>
                        <span className="text-muted-foreground text-sm transition-all duration-300">
                          /{isYearly ? "year" : "month"}
                        </span>
                      </div>
                      <p className={`text-xs text-muted-foreground mt-1.5 transition-all duration-300 ${isYearly ? "opacity-100" : "opacity-0 h-0 mt-0 overflow-hidden"}`}>
                        {plan.yearlyPerMonth}
                      </p>
                    </div>
                  </div>

                  <div className="mb-6 space-y-2">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <span className="text-2xl">{plan.minutes}</span>
                      <span className="text-muted-foreground">minutes of finished video</span>
                    </div>
                    <div className="text-sm text-muted-foreground">{plan.upload}</div>
                    <div className="text-xs text-muted-foreground/70 mt-1">{plan.forWho}</div>
                  </div>

                  <div className="h-px bg-surface-1 mb-6" />

                  <ul className="space-y-3 flex-1 mb-8">
                    {SHARED_FEATURES.map((feat) => (
                      <li key={feat} className="flex items-center gap-3 text-sm">
                        <div className="w-5 h-5 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center flex-shrink-0">
                          <CheckCircle2 className="w-3 h-3 text-primary" />
                        </div>
                        {feat}
                      </li>
                    ))}
                  </ul>

                  {isCurrent ? (
                    <div className="flex items-center justify-center gap-2 rounded-full py-3 px-6 bg-primary/10 border border-primary/30 text-primary font-semibold text-sm">
                      <Check className="w-4 h-4" />
                      Current Plan
                    </div>
                  ) : (
                    <button
                      onClick={() => handleSelectPlan(plan.key)}
                      disabled={!planKnown || updateSubscription.isPending || checkoutFor !== null}
                      data-testid={`button-plan-${plan.key}`}
                      className={`w-full rounded-full py-3 px-6 font-semibold text-sm transition-all duration-300 ${
                        isPro
                          ? "btn-gradient-cta text-white"
                          : "bg-surface-1 border border-hairline hover:bg-surface-2 hover:border-hairline-strong hover:shadow-[0_0_20px_rgba(108,59,255,0.12)]"
                      } disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                      {!planKnown
                        ? "Checking your plan…"
                        : checkoutFor === plan.key
                        ? "Opening checkout…"
                        : isDowngrade
                        ? updateSubscription.isPending
                          ? "Switching…"
                          : `Switch to ${plan.name}`
                        : `Get ${plan.name}`}
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
        <p className="text-center text-xs text-muted-foreground mt-8 opacity-60">
          No credit card required · Cancel anytime · All plans include a 7-day free trial
        </p>
      </section>

      {/* ── Footer CTA ── */}
      <section className="w-full py-24 text-center relative overflow-hidden">
        {/* Animated gradient background */}
        <div
          className="absolute inset-0 animate-gradient-shift"
          style={{
            background: "linear-gradient(135deg, rgba(108,59,255,0.15) 0%, rgba(155,107,255,0.08) 40%, rgba(108,59,255,0.12) 70%, rgba(155,107,255,0.18) 100%)",
          }}
        />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(108,59,255,0.2)_0%,transparent_65%)]" />
        {/* Top border shimmer */}
        <div
          className="absolute top-0 left-0 right-0 h-px animate-gradient-shift"
          style={{ background: "linear-gradient(90deg, transparent, rgba(155,107,255,0.6), rgba(108,59,255,0.8), rgba(155,107,255,0.6), transparent)" }}
        />

        <div className="relative z-10 flex flex-col items-center reveal">
          <h2 className="text-4xl md:text-5xl font-bold mb-4 glow-text">Turn your next video into your best one.</h2>
          <p className="text-muted-foreground text-lg mb-10 max-w-lg">
The tedious part is the part a machine should do.<br />Upload one take and see how much shorter it gets.
          </p>
          <Link
            href="/dashboard"
            className="glow-btn btn-gradient-cta animate-glow-pulse text-white h-16 px-12 rounded-full font-bold text-xl flex items-center gap-3"
          >
            Start Editing Free
            <Zap className="w-5 h-5" />
          </Link>
          <p className="text-xs text-muted-foreground mt-5 opacity-60">No credit card required · Cancel anytime</p>
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
              className="absolute left-1/4 -top-24 w-1/2 h-40 pointer-events-none opacity-70"
              style={{
                background:
                  "radial-gradient(ellipse at center, var(--wordmark-bloom) 0%, var(--wordmark-bloom) 18%, transparent 78%)",
              }}
            />
          </div>

          <div className="mt-10 grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-8 text-sm">
            <div>
              <p className="text-xs uppercase tracking-widest text-muted-foreground/70 mb-3">Product</p>
              <ul className="flex flex-col">
                <li><a href="/#how-it-works" className="min-h-11 inline-flex items-center text-muted-foreground hover:text-foreground transition-colors">How it works</a></li>
                <li><a href="/#features" className="min-h-11 inline-flex items-center text-muted-foreground hover:text-foreground transition-colors">Features</a></li>
                <li><a href="/#pricing" className="min-h-11 inline-flex items-center text-muted-foreground hover:text-foreground transition-colors">Pricing</a></li>
              </ul>
            </div>
            <div>
              <p className="text-xs uppercase tracking-widest text-muted-foreground/70 mb-3">Account</p>
              <ul className="flex flex-col">
                <li><Link href="/login" className="min-h-11 inline-flex items-center text-muted-foreground hover:text-foreground transition-colors">Log in</Link></li>
                <li><Link href="/login?mode=signup" className="min-h-11 inline-flex items-center text-muted-foreground hover:text-foreground transition-colors">Create an account</Link></li>
                <li><Link href="/dashboard" className="min-h-11 inline-flex items-center text-muted-foreground hover:text-foreground transition-colors">Your projects</Link></li>
              </ul>
            </div>
            <div>
              <p className="text-xs uppercase tracking-widest text-muted-foreground/70 mb-3">Earn</p>
              <ul className="flex flex-col">
                <li>
                  <a
                    href="https://users.freemius.com/"
                    target="_blank"
                    rel="noreferrer"
                    className="min-h-11 inline-flex items-center text-muted-foreground hover:text-foreground transition-colors"
                    data-testid="link-become-affiliate"
                  >
                    Become an affiliate
                  </a>
                </li>
                {/* The number is the offer. Under the link rather than inside
                    it, so the link stays a link and the terms stay readable. */}
                <li className="text-xs text-muted-foreground/70 leading-relaxed max-w-[16rem] pt-1">
                  25% of every payment, for a year.
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-10 pt-6 border-t border-hairline-faint flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground/70">
            <span>© {new Date().getFullYear()} Editly</span>
            <span>Stop editing. Start describing.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
