import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Play, Sparkles, Zap, CheckCircle2, ArrowRight, Check, Upload, MessageSquareText, Send } from "lucide-react";
import { useGetSubscription, useUpdateSubscription, getGetSubscriptionQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { fetchCheckoutConfig, openCheckout } from "@/lib/checkout";
import { useAuth } from "@/lib/auth";
import { ThemeToggle } from "@/components/theme-toggle";
import { Logo } from "@/components/logo";
import { PLANS, SHARED_FEATURES, FREE_TIER } from "@/lib/pricing";

function useScrollReveal() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
          }
        });
      },
      { threshold: 0.15 }
    );
    const children = el.querySelectorAll(".reveal");
    children.forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, []);
  return ref;
}

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

  return (
    <div className="w-full flex flex-col items-center" ref={sectionsRef}>

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
          {/* A preference, not a destination. It keeps its place from `sm` up
              and gives the row back to the two doors on a phone — where it is
              still one tap away in the footer. */}
          <span className="hidden sm:inline-flex"><ThemeToggle /></span>
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
          <span className="text-sm font-medium text-foreground/80">Meet Noah — tell him what you want</span>
          <span className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.8)]"
            style={{ animation: "glow-pulse 2s ease-in-out infinite" }} />
        </div>

        {/* Headline */}
        <h1
          className="text-5xl md:text-7xl font-extrabold tracking-tight mb-6 max-w-4xl leading-[1.1] animate-fade-up"
          style={{ animationDelay: "200ms" }}
        >
          <span className="glow-text">Stop editing.</span>
          <br />
          <span
            className="animate-gradient-shift"
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
          back — on every video.
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

        {/* Hero — the product, recorded.
            What was here was a drawing of an editor: an empty black rectangle
            with chips and a fake waveform on it. Every claim on this page is
            about a product and the largest thing on it showed no product.

            This is `tools/demo-capture.mjs` driving the built app through one
            real edit — a sentence typed, a plan back, the render moving, and
            the finished 9:16 cut with its captions on it. Regenerate it with
            `pnpm run vercel:build && node tools/demo-capture.mjs`; when a
            button moves, the recording moves with it. */}
        <div
          ref={mockupRef}
          className="mt-16 sm:mt-20 w-full max-w-5xl animate-fade-up"
          style={{ animationDelay: "560ms" }}
        >
          <div className="rounded-2xl glass-panel overflow-hidden border border-hairline p-1.5 sm:p-2"
            style={{
              boxShadow: "0 40px 80px rgba(108,59,255,0.28), 0 80px 160px rgba(108,59,255,0.10), 0 0 0 1px rgba(155,107,255,0.12)",
            }}
          >
            {/* force-dark: this is a picture of a video editor, and a video
                editor is dark whatever the surrounding page is doing. */}
            <div className="force-dark rounded-xl overflow-hidden relative bg-[#0a090b]">
              {/* Two recordings, one per shape.
                  A 1280-wide desktop capture scaled into a 390px phone is a
                  picture of text nobody can read, and the largest thing on the
                  page becoming a grey smudge on the device most people arrive
                  on is worse than no video at all. The app has a phone layout,
                  so the phone gets a recording of that one. `<source media>` is
                  not reliable across browsers for this, so it is two elements
                  and a breakpoint — only one of which ever has a src attached,
                  because `hidden` does not stop a video downloading. */}
              <video
                className="hidden sm:block w-full h-auto"
                // Muted and inline are what make autoplay legal on a phone;
                // without both, iOS shows a play button over a still frame.
                autoPlay
                muted
                loop
                playsInline
                preload="metadata"
                poster="/demo-editor.jpg"
                aria-label="A recording of Editly turning a raw take into a vertical clip"
              >
                <source src="/demo-editor.webm" type="video/webm" />
                <source src="/demo-editor.mp4" type="video/mp4" />
              </video>
              <video
                className="sm:hidden w-full h-auto"
                autoPlay
                muted
                loop
                playsInline
                preload="metadata"
                poster="/demo-editor-phone.jpg"
                aria-label="A recording of Editly turning a raw take into a vertical clip"
              >
                <source src="/demo-editor-phone.webm" type="video/webm" />
                <source src="/demo-editor-phone.mp4" type="video/mp4" />
              </video>
            </div>
          </div>
          <p className="mt-4 text-xs sm:text-sm text-muted-foreground text-center">
            A real edit, recorded in the app. 12.3 seconds in, 6.5 out.
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

          <div className="grid md:grid-cols-3 gap-8">
            {[
              { num: "01", icon: Upload, title: "Upload the raw take", desc: "The unedited one, with all the ums and restarts still in it. That is the point.", delay: "0ms" },
              { num: "02", icon: MessageSquareText, title: "Say what you want", desc: "\"Cut the dead air and make it vertical for TikTok.\" Editly tells you exactly what it will do before it does it.", delay: "120ms" },
              { num: "03", icon: Send, title: "Post it", desc: "Framed for TikTok, Reels or Shorts, and waiting for you when you come back.", delay: "240ms" },
            ].map((step) => (
              <div
                key={step.num}
                className="reveal glass-panel p-8 rounded-2xl relative overflow-hidden group cursor-default transition-all duration-500 hover:border-primary/30 hover:shadow-[0_0_40px_rgba(108,59,255,0.2)] hover:-translate-y-1"
                style={{ transitionDelay: step.delay }}
              >
                <div className="absolute -top-10 -right-10 w-32 h-32 bg-primary/20 rounded-full blur-[50px] group-hover:bg-secondary/40 transition-colors duration-700" />
                <span className="text-6xl font-extrabold text-foreground/[0.06] mb-4 block group-hover:text-foreground/[0.10] transition-colors">
                  {step.num}
                </span>
                <div className="w-10 h-10 rounded-xl bg-primary/20 border border-primary/30 flex items-center justify-center mb-4 group-hover:shadow-[0_0_15px_rgba(108,59,255,0.5)] transition-shadow">
                  <step.icon className="w-5 h-5 text-primary" />
                </div>
                <h3 className="text-xl font-bold mb-3">{step.title}</h3>
                <p className="text-muted-foreground leading-relaxed">{step.desc}</p>
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
                    "Every silence and pause cut, framed for TikTok, Reels and Shorts — or YouTube, or square — and the levels fixed. From one sentence.",
                },
                {
                  title: "The moments worth keeping, found for you",
                  detail:
                    "The strongest thirty seconds of a long take, or the whole thing cut into separate clips, each titled by what the speaker actually said. Open any of them and keep editing.",
                },
                {
                  title: "Captions in your own words",
                  detail:
                    "Burned in from what you said, not from a template — in English or Arabic, laid out in the direction that language reads.",
                },
                {
                  title: "It looks edited, not processed",
                  detail:
                    "Dissolves between the cuts, your own music ducking out of the way while you talk, and a grade — warm, cinematic, or matched to a clip whose colour you liked.",
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

          <div className="relative reveal">
            <div className="absolute inset-0 bg-secondary/15 blur-[100px] rounded-full pointer-events-none" />
            <div className="glass-panel p-6 rounded-2xl relative z-10 transition-all duration-500 hover:shadow-[0_0_60px_rgba(108,59,255,0.2)]">
              <div className="grid grid-cols-2 gap-4">
                {[
                  // Dimmed means "not built yet". All four ship today —
                  // transitions arrived last, as fade in/out — so nothing on
                  // this grid pretends to be future work any more.
                  { label: "B-Roll", dimmed: false },
                  { label: null, icon: true },
                  { label: "Captions", dimmed: false },
                  { label: "Transitions", dimmed: false },
                ].map((cell, i) => (
                  <div
                    key={i}
                    className={`aspect-square rounded-xl flex items-center justify-center border transition-all duration-300 cursor-default
                      ${cell.icon
                        ? "bg-primary/20 border-primary/40 shadow-[0_0_20px_rgba(108,59,255,0.25)] hover:shadow-[0_0_35px_rgba(108,59,255,0.5)] hover:scale-[1.04]"
                        : "bg-band border-hairline-faint hover:border-hairline hover:bg-surface-1"
                      }`}
                  >
                    {cell.icon ? (
                      <Sparkles className="w-8 h-8 text-primary animate-sparkle" />
                    ) : (
                      <span className={`text-sm font-medium ${cell.dimmed ? "text-foreground/35" : "text-foreground/80"}`}>
                        {cell.label}
                      </span>
                    )}
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
      <footer className="w-full border-t border-hairline-faint py-8 px-6">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-5 sm:gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="opacity-60">© {new Date().getFullYear()} Editly</span>
            {/* Where the theme control goes on a phone, since the header gives
                its place to the two doors. Present on every width so there is
                one answer to "where is it", not two. */}
            <span className="sm:hidden"><ThemeToggle /></span>
          </div>
          <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-6 text-center">
            <a href="/#pricing" className="min-h-[44px] inline-flex items-center hover:text-foreground transition-colors">
              Pricing
            </a>
            <a
              href="https://users.freemius.com/"
              target="_blank"
              rel="noreferrer"
              className="min-h-[44px] inline-flex items-center hover:text-foreground transition-colors"
              data-testid="link-become-affiliate"
            >
              Become an affiliate — earn 25% of every payment for a year
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
