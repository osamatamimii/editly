import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Play, Sparkles, Zap, CheckCircle2, ArrowRight, Check, Upload, MessageSquareText, Send } from "lucide-react";
import { useGetSubscription, useUpdateSubscription, getGetSubscriptionQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { fetchCheckoutConfig, openCheckout } from "@/lib/checkout";
import { useAuth } from "@/lib/auth";
import { ThemeToggle } from "@/components/theme-toggle";
import { Logo } from "@/components/logo";

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

/* Deterministic particle seeds — golden-angle distribution, no Math.random at render */
const PARTICLES = Array.from({ length: 30 }, (_, i) => ({
  left:    (i * 137.508) % 100,
  bottom:  (i * 17 + 5) % 50,
  size:    2 + (i % 4),
  opacity: 0.35 + (i % 5) * 0.1,
  dur:     7 + (i % 8) * 1.2,
  delay:   -((i * 3.1) % 14),
  drift:   ((i * 23) % 60) - 30,
}));

/**
 * The tiers, priced on minutes of finished video.
 *
 * The quotas come from what people publish, not from round numbers. A
 * short-form creator posts a few times a week at half a minute, which is five
 * to twenty minutes a month — sixty is headroom, not a leash. A long-form
 * YouTuber lands near a hundred. What sells Pro is not its minutes but its
 * four-hour upload: a whole podcast episode as one file.
 */
const PLANS = [
  {
    key: "creator" as const,
    name: "Creator",
    price: 12,
    yearlyPrice: 115,
    yearlyPerMonth: "$9.6/month billed yearly",
    minutes: 60,
    forWho: "Short-form: TikTok, Reels, Shorts",
    upload: "Upload up to 30 minutes",
    color: "emerald",
  },
  {
    key: "pro" as const,
    name: "Pro",
    price: 29,
    yearlyPrice: 279,
    yearlyPerMonth: "$23.25/month billed yearly",
    minutes: 400,
    forWho: "Long-form: YouTube and podcasts",
    upload: "Upload a 4-hour episode as one file",
    color: "violet",
    popular: true,
  },
  {
    key: "studio" as const,
    name: "Studio",
    price: 79,
    yearlyPrice: 758,
    yearlyPerMonth: "$63.2/month billed yearly",
    minutes: 1000,
    forWho: "Teams and agencies",
    upload: "3 seats, brand kit, API",
    color: "fuchsia",
  },
] as const;

/**
 * The first line is the one that matters.
 *
 * "60 minutes a month" is read by a podcaster as "one episode" — the exact
 * opposite of the truth, and the reading most likely to lose the long-form
 * audience this pricing was built for. Every competitor meters uploaded hours
 * or credits, so people arrive with that model already loaded and apply it to
 * us by default.
 *
 * The fix is not a parenthetical. It is naming the unit ("minutes of finished
 * video") and then saying the difference out loud, where it stops being a
 * clarification and becomes the best line on the page.
 */
const SHARED_FEATURES = [
  "Upload as much footage as you like — you only pay for what you publish",
  "No watermark",
  "Unlimited edits — asking again is free",
  "Match the style of a video you like",
];

export default function Home() {
  const sectionsRef = useScrollReveal();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { data: subscription } = useGetSubscription({
    query: { queryKey: getGetSubscriptionQueryKey() }
  });
  const updateSubscription = useUpdateSubscription();

  const [isYearly, setIsYearly] = useState(false);
  /** Which plan's checkout is opening, so only that button shows a spinner. */
  const [checkoutFor, setCheckoutFor] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  /* ── Parallax refs ─────────────────────────────────────── */
  const heroRef    = useRef<HTMLElement>(null);
  const orb1Ref    = useRef<HTMLDivElement>(null);
  const orb2Ref    = useRef<HTMLDivElement>(null);
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
      if (orb1Ref.current)   orb1Ref.current.style.translate   = `${x * 2}px ${y * 2}px`;
      if (orb2Ref.current)   orb2Ref.current.style.translate   = `${-x * 1.5}px ${-y * 1.5}px`;
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
  const RANK = { free: 0, creator: 1, pro: 2, studio: 3 } as const;

  const handleSelectPlan = async (plan: "creator" | "pro" | "studio") => {
    const current = (subscription?.plan ?? "free") as keyof typeof RANK;

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
      <div className="fixed inset-0 pointer-events-none -z-10 overflow-hidden">
        {/* Strong top purple glow */}
        <div style={{
          position: "absolute", inset: 0,
          background: "radial-gradient(ellipse 100% 55% at 50% -5%, var(--wash-top) 0%, var(--wash-top-mid) 40%, transparent 70%)",
        }} />
        {/* Mid indigo bloom */}
        <div style={{
          position: "absolute", inset: 0,
          background: "radial-gradient(ellipse 80% 45% at 50% 50%, var(--wash-mid) 0%, transparent 65%)",
        }} />
        {/* Bottom-left accent */}
        <div style={{
          position: "absolute", inset: 0,
          background: "radial-gradient(ellipse 60% 40% at 15% 85%, var(--wash-left) 0%, transparent 65%)",
        }} />
        {/* Bottom-right accent */}
        <div style={{
          position: "absolute", inset: 0,
          background: "radial-gradient(ellipse 60% 40% at 85% 80%, var(--wash-right) 0%, transparent 65%)",
        }} />

        {/* Slow diagonal light sweep */}
        <div
          className="animate-light-sweep"
          style={{
            position: "absolute",
            top: "-10%", left: "-10%",
            width: "40%", height: "140%",
            background: "linear-gradient(105deg, transparent 0%, rgba(155,107,255,0.07) 40%, rgba(192,132,252,0.12) 50%, rgba(155,107,255,0.07) 60%, transparent 100%)",
            filter: "blur(1px)",
          }}
        />

        {/* Noise / grain texture */}
        <div style={{
          position: "absolute", inset: 0,
          backgroundImage: "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E\")",
          backgroundRepeat: "repeat",
          backgroundSize: "128px 128px",
        }} className="grain-layer" />
      </div>

      {/* ── Header ── */}
      <header className="w-full max-w-7xl mx-auto px-6 py-6 flex items-center justify-between z-10 relative animate-fade-in">
        <div className="flex items-center gap-2.5">
          <Logo className="w-9 h-9 text-brand-mark logo-animated" />
          <span className="font-bold text-xl tracking-tight">Editly</span>
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
        <div className="flex items-center gap-2 sm:gap-3">
          <ThemeToggle />
          {user ? (
            <Link
              href="/dashboard"
              data-testid="link-dashboard"
              className="glow-btn btn-gradient-cta text-white px-6 py-2 rounded-full font-medium animate-shimmer-border border border-transparent"
            >
              Dashboard
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                data-testid="link-log-in"
                className="px-3 sm:px-4 py-2 rounded-full font-medium text-sm text-muted-foreground hover:text-foreground hover:bg-surface-1 transition-colors"
              >
                Log in
              </Link>
              <Link
                href="/login?mode=signup"
                data-testid="link-sign-up"
                className="glow-btn btn-gradient-cta text-white px-5 sm:px-6 py-2 rounded-full font-medium text-sm sm:text-base whitespace-nowrap animate-shimmer-border border border-transparent"
              >
                Sign up free
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
        {/* Animated orbs */}
        <div
          ref={orb1Ref}
          className="absolute top-1/2 left-1/2 w-[1000px] h-[1000px] rounded-full pointer-events-none animate-orb-drift"
          style={{
            background: "radial-gradient(circle, rgba(108,59,255,0.45) 0%, rgba(155,107,255,0.2) 40%, transparent 70%)",
            filter: "blur(50px)",
          }}
        />
        <div
          ref={orb2Ref}
          className="absolute top-1/3 right-1/4 w-[500px] h-[500px] rounded-full pointer-events-none"
          style={{
            background: "radial-gradient(circle, rgba(155,107,255,0.3) 0%, rgba(192,132,252,0.1) 50%, transparent 70%)",
            filter: "blur(60px)",
            animation: "orb-drift 25s ease-in-out infinite reverse",
          }}
        />

        {/* Floating particles — only in hero viewport */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          {PARTICLES.map((p, i) => (
            <div
              key={i}
              className="absolute rounded-full animate-particle-drift"
              style={{
                left: `${p.left}%`,
                bottom: `${p.bottom}%`,
                width:  `${p.size}px`,
                height: `${p.size}px`,
                background: i % 3 === 0 ? "rgba(155,107,255,1)" : i % 3 === 1 ? "rgba(108,59,255,1)" : "rgba(192,132,252,1)",
                "--p-opacity": p.opacity,
                "--p-dur":     `${p.dur}s`,
                "--p-delay":   `${p.delay}s`,
                "--p-drift":   `${p.drift}px`,
              } as React.CSSProperties}
            />
          ))}
        </div>

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
          Upload the raw take and say what you want. Every silence cut, framed to
          9:16, ready to post — about three hours of your evening back, on every
          video.
        </p>

        {/* CTA Buttons */}
        <div
          className="flex flex-col sm:flex-row items-center gap-4 animate-fade-up"
          style={{ animationDelay: "440ms" }}
        >
          <Link
            href="/dashboard"
            className="glow-btn btn-gradient-cta flex items-center justify-center gap-2 text-white h-14 px-8 rounded-full font-semibold text-lg"
          >
            <Play className="w-5 h-5 fill-current" />
            Upload a raw take
          </Link>
          <button className="group flex items-center justify-center gap-2 h-14 px-8 rounded-full font-semibold text-lg bg-surface-1 hover:bg-surface-1 border border-hairline transition-all duration-300 hover:border-primary/40 hover:shadow-[0_0_24px_rgba(108,59,255,0.2)] backdrop-blur-sm">
            Watch Demo
            <ArrowRight className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-1" />
          </button>
        </div>

        {/* Hero Mockup */}
        <div
          ref={mockupRef}
          className="mt-20 w-full max-w-5xl animate-fade-up animate-float"
          style={{ animationDelay: "560ms", animationDuration: "6s" } as React.CSSProperties}
        >
          <div className="rounded-2xl glass-panel overflow-hidden border border-hairline p-2"
            style={{
              boxShadow: "0 40px 80px rgba(108,59,255,0.3), 0 80px 160px rgba(108,59,255,0.12), 0 0 0 1px rgba(155,107,255,0.12)",
            }}
          >
            {/* force-dark: this is a picture of a video editor, and a video
                editor is dark whatever the surrounding page is doing. */}
            <div className="force-dark w-full aspect-[16/9] rounded-xl overflow-hidden relative text-foreground"
              style={{ background: "linear-gradient(135deg, #080512 0%, #0a0614 40%, #060310 100%)" }}
            >
              {/* Abstract bokeh blobs — suggest out-of-focus video subjects */}
              <div className="absolute pointer-events-none"
                style={{ top: "-10%", left: "-5%", width: "45%", height: "70%",
                  background: "radial-gradient(circle, rgba(20,184,166,0.28) 0%, transparent 70%)",
                  filter: "blur(60px)" }}
              />
              <div className="absolute pointer-events-none"
                style={{ top: "20%", right: "5%", width: "35%", height: "55%",
                  background: "radial-gradient(circle, rgba(251,146,60,0.18) 0%, transparent 70%)",
                  filter: "blur(50px)" }}
              />
              <div className="absolute pointer-events-none"
                style={{ bottom: "5%", left: "30%", width: "40%", height: "50%",
                  background: "radial-gradient(circle, rgba(108,59,255,0.32) 0%, transparent 70%)",
                  filter: "blur(70px)" }}
              />
              {/* Subtle film grain / scanline texture */}
              <div className="absolute inset-0 pointer-events-none opacity-[0.035]"
                style={{ backgroundImage: "repeating-linear-gradient(0deg, rgba(255,255,255,0.6) 0px, rgba(255,255,255,0.6) 1px, transparent 1px, transparent 4px)" }}
              />
              {/* Vignette so edges stay dark */}
              <div className="absolute inset-0 pointer-events-none"
                style={{ background: "radial-gradient(ellipse at 50% 45%, transparent 35%, rgba(0,0,0,0.75) 100%)" }}
              />

              {/* REC indicator + timecode — top left */}
              <div className="absolute top-4 left-4 flex items-center gap-2 z-10"
                style={{ animation: "fade-in 0.4s 0.8s both" }}
              >
                <span className="w-2 h-2 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.9)]"
                  style={{ animation: "glow-pulse 1.4s ease-in-out infinite" }} />
                <span className="text-[10px] font-mono text-white/60 tracking-widest">REC&nbsp; 00:14 / 01:02</span>
              </div>

              {/* Resolution badge — top right, inset to clear the chat panel */}
              <div className="absolute top-4 z-10"
                style={{ right: "310px", animation: "fade-in 0.4s 0.9s both" }}
              >
                <span className="text-[9px] font-mono text-white/40 bg-surface-1 border border-hairline px-2 py-0.5 rounded">
                  1080p
                </span>
              </div>

              {/* Animated AI-caption strip — floats just above the timeline */}
              <div className="absolute z-10 left-1/2 -translate-x-1/2 whitespace-nowrap"
                style={{ bottom: "120px", animation: "chat-slide-in 0.6s 2.2s cubic-bezier(0.16,1,0.3,1) both" }}
              >
                <div className="bg-black/70 backdrop-blur-sm border border-primary/30 px-4 py-1.5 rounded-full text-xs text-white/90 font-medium shadow-[0_0_16px_rgba(108,59,255,0.35)] flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_6px_rgba(108,59,255,0.9)]"
                    style={{ animation: "glow-pulse 1.8s ease-in-out infinite" }} />
                  🎵 Beat drop incoming — zoom activated
                </div>
              </div>

              {/* Gradient fade at the bottom so timeline merges smoothly */}
              <div className="absolute inset-x-0 bottom-0 h-36 pointer-events-none"
                style={{ background: "linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.6) 50%, transparent 100%)" }}
              />

              {/* Timeline bar */}
              <div className="absolute bottom-0 left-0 right-0 h-28 p-4 flex flex-col justify-end">
                <div className="w-full h-14 bg-surface-1 rounded-lg border border-hairline relative overflow-hidden">
                  {/* Animated progress fill */}
                  <div className="timeline-progress absolute top-0 left-0 bottom-0 bg-primary/20 border-r-2 border-secondary shadow-[0_0_20px_rgba(155,107,255,0.8)]" />
                  {/* Active edit segment — the highlighted clip being edited */}
                  <div
                    className="absolute top-0 bottom-0 rounded-sm"
                    style={{
                      left: "28%", width: "14%",
                      background: "rgba(108,59,255,0.45)",
                      boxShadow: "0 0 18px rgba(108,59,255,0.7), inset 0 0 8px rgba(155,107,255,0.3)",
                      borderLeft: "2px solid rgba(155,107,255,0.9)",
                      borderRight: "2px solid rgba(155,107,255,0.9)",
                    }}
                  />
                  {/* Playhead */}
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-secondary shadow-[0_0_8px_rgba(155,107,255,1)]"
                    style={{ left: "38%", animation: "timeline-progress 3s 1s cubic-bezier(0.16,1,0.3,1) both" }}
                  />
                  {/* Animated waveform */}
                  <div className="absolute inset-0 flex items-center gap-[2px] px-3">
                    {WAVE_BARS.map((bar, i) => (
                      <div
                        key={i}
                        className={`wave-bar flex-1 rounded-full min-w-[2px] ${
                          i >= 13 && i <= 19 ? "bg-secondary/70" : "bg-surface-3"
                        }`}
                        style={{
                          height: `${bar.height}%`,
                          "--dur": `${bar.dur}s`,
                          "--delay": `${bar.delay}s`,
                        } as React.CSSProperties}
                      />
                    ))}
                  </div>
                </div>
              </div>

              {/* Chat overlay */}
              <div className="absolute top-6 right-6 w-72 rounded-xl bg-background/80 backdrop-blur-md border border-hairline p-4 shadow-[0_20px_40px_rgba(0,0,0,0.5)]"
                style={{ boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 20px 40px rgba(0,0,0,0.5)" }}
              >
                <div className="flex items-center gap-2 mb-3 pb-3 border-b border-hairline">
                  <div className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.8)]" />
                  <span className="text-xs font-semibold text-muted-foreground">Editly AI</span>
                </div>
                <div className="flex flex-col gap-3">
                  <div className="chat-bubble-1 self-end bg-primary/20 text-white px-3 py-2 rounded-xl rounded-br-sm text-xs border border-primary/30">
                    "Make it punchy, add zoom on the beat drops."
                  </div>
                  <div className="chat-bubble-2 self-start bg-surface-1 px-3 py-2 rounded-xl rounded-bl-sm text-xs border border-hairline flex items-center gap-2">
                    <Sparkles className="w-3 h-3 text-secondary flex-shrink-0" />
                    <span>Applying dynamic beat sync...</span>
                  </div>
                  <div
                    className="self-start bg-surface-1 px-3 py-2 rounded-xl rounded-bl-sm text-xs border border-hairline flex items-center gap-1.5"
                    style={{ animation: "chat-slide-in 0.5s 3.5s cubic-bezier(0.16,1,0.3,1) both" }}
                  >
                    <span className="typing-dot w-1.5 h-1.5 rounded-full bg-secondary inline-block" />
                    <span className="typing-dot w-1.5 h-1.5 rounded-full bg-secondary inline-block" />
                    <span className="typing-dot w-1.5 h-1.5 rounded-full bg-secondary inline-block" />
                  </div>
                </div>
              </div>

              {/* Platform badges */}
              <div
                className="absolute top-6 left-6 flex flex-col gap-2"
                style={{ animation: "fade-in 0.5s 1s ease both" }}
              >
                {["TikTok", "Reels", "Shorts"].map((p, i) => (
                  <div
                    key={p}
                    className="px-3 py-1 rounded-full bg-black/60 backdrop-blur-md border border-hairline text-xs font-medium text-white/80"
                    style={{ animation: `fade-up 0.5s ${1 + i * 0.15}s cubic-bezier(0.16,1,0.3,1) both` }}
                  >
                    {p}
                  </div>
                ))}
              </div>
            </div>
          </div>
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
            <ul className="space-y-5">
              {[
                "Every silence and pause cut automatically",
                "Reframed to 9:16 for TikTok, Reels and Shorts",
                "Renders while you close the tab",
                "Your footage stays private to your account",
                "Captions and colour grading — in progress",
              ].map((feat, i) => (
                <li
                  key={i}
                  className="reveal flex items-center gap-4 group"
                  style={{ transitionDelay: `${i * 80}ms` }}
                >
                  <div className="w-9 h-9 flex-shrink-0 rounded-full bg-primary/15 flex items-center justify-center border border-primary/30 shadow-[0_0_8px_rgba(108,59,255,0.2)] group-hover:shadow-[0_0_16px_rgba(108,59,255,0.5)] group-hover:border-primary/60 transition-all duration-300">
                    <CheckCircle2 className="w-4 h-4 text-secondary" />
                  </div>
                  <span className="text-lg font-medium group-hover:text-foreground transition-colors">{feat}</span>
                </li>
              ))}
            </ul>
            <div className="mt-10 reveal">
              <Link
                href="/dashboard"
                className="group inline-flex items-center gap-2 text-primary hover:text-secondary font-semibold transition-colors"
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
                  { label: "B-Roll", dimmed: true },
                  { label: null, icon: true },
                  { label: "Captions", dimmed: true },
                  { label: "Transitions", dimmed: true },
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
                      <span className="text-sm font-medium text-foreground/50">{cell.label}</span>
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
              className={`px-6 py-2 rounded-full text-sm font-medium transition-all duration-300 ${
                !isYearly
                  ? "bg-primary text-white shadow-[0_0_16px_rgba(108,59,255,0.5)]"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setIsYearly(true)}
              className={`flex items-center gap-2 px-6 py-2 rounded-full text-sm font-medium transition-all duration-300 ${
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

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-stretch">
          {PLANS.map((plan, i) => {
            const isCurrent = subscription?.plan === plan.key;
            const isPro = "popular" in plan && plan.popular;
            const isDowngrade =
              RANK[plan.key] < RANK[(subscription?.plan ?? "free") as keyof typeof RANK];
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
                      disabled={updateSubscription.isPending || checkoutFor !== null}
                      data-testid={`button-plan-${plan.key}`}
                      className={`w-full rounded-full py-3 px-6 font-semibold text-sm transition-all duration-300 ${
                        isPro
                          ? "btn-gradient-cta text-white"
                          : "bg-surface-1 border border-hairline hover:bg-surface-2 hover:border-hairline-strong hover:shadow-[0_0_20px_rgba(108,59,255,0.12)]"
                      } disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                      {checkoutFor === plan.key
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
            className="text-center text-sm text-red-400 mt-6 max-w-md mx-auto"
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
    </div>
  );
}
