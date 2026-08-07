import { useEffect, useRef, useState } from "react";

/**
 * The looping thing behind the headline.
 *
 * It is a waveform whose silences collapse — the one action the product
 * performs, shown rather than described. A creator recognises their own
 * timeline in it before they have read a word.
 *
 * Drawn rather than filmed, for three reasons that all matter on a landing
 * page: it costs no download, it is sharp on any display, and it loops with no
 * seam. A background video large enough to look good is several megabytes
 * standing between a visitor and the headline they came to read.
 *
 * If a real clip does arrive, pass `videoSrc` and it takes over — the drawing
 * stays as the fallback for a browser that will not play it, and for anyone who
 * has asked their system for less motion.
 */

interface HeroBackdropProps {
  /** Optional looping clip. Falls back to the drawn waveform if absent or unplayable. */
  videoSrc?: string;
  /** Poster for the video, shown while it buffers. */
  posterSrc?: string;
}

/** One cycle: idle, mark the silences, collapse them, settle, reset. */
const CYCLE_MS = 11_000;

const BAR_COUNT = 96;
const BAR_GAP = 3;

/**
 * Deterministic pseudo-random heights.
 *
 * A real random source would give a different waveform on every mount, which
 * means the shape changes under anyone who reloads — and the whole point is
 * that this reads as one specific timeline.
 */
function seededHeight(index: number): number {
  const a = Math.sin(index * 12.9898) * 43758.5453;
  const b = Math.sin(index * 78.233) * 12345.6789;
  const noise = (a - Math.floor(a)) * 0.6 + (b - Math.floor(b)) * 0.4;
  // Two overlapping slow waves give speech-like swells rather than static.
  const envelope = 0.55 + 0.3 * Math.sin(index / 7) + 0.15 * Math.sin(index / 3.1);
  return Math.max(0.08, Math.min(1, noise * envelope));
}

/** Index ranges that stand in for dead air. */
const SILENCES: Array<[number, number]> = [
  [14, 23],
  [38, 50],
  [67, 74],
  [84, 91],
];

function isSilent(index: number): boolean {
  return SILENCES.some(([from, to]) => index >= from && index < to);
}

/** Smooth acceleration and deceleration — linear collapse looks mechanical. */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function HeroBackdrop({ videoSrc, posterSrc }: HeroBackdropProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [videoFailed, setVideoFailed] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(query.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const showCanvas = !videoSrc || videoFailed || reducedMotion;

  useEffect(() => {
    if (!showCanvas) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let frame = 0;
    let width = 0;
    let height = 0;

    const resize = () => {
      // Draw at device resolution; a hairline bar at 1x on a retina screen is
      // the difference between "crisp" and "smudged".
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    /**
     * How far the collapse has progressed, 0 to 1, and how strongly the
     * silences are being called out before they go.
     */
    const phases = (elapsed: number) => {
      const t = (elapsed % CYCLE_MS) / CYCLE_MS;
      // 0–.32 idle · .32–.46 mark · .46–.74 collapse · .74–.88 hold · .88–1 reset
      const marked = t < 0.32 ? 0 : t < 0.46 ? (t - 0.32) / 0.14 : t < 0.88 ? 1 : 1 - (t - 0.88) / 0.12;
      const collapsed = t < 0.46 ? 0 : t < 0.74 ? easeInOut((t - 0.46) / 0.28) : t < 0.88 ? 1 : 1 - easeInOut((t - 0.88) / 0.12);
      return { t, marked: Math.max(0, Math.min(1, marked)), collapsed: Math.max(0, Math.min(1, collapsed)) };
    };

    const draw = (now: number) => {
      const { t, marked, collapsed } = phases(now);
      ctx.clearRect(0, 0, width, height);

      const barWidth = Math.max(2, width / BAR_COUNT - BAR_GAP);
      const centreY = height / 2;
      // Everything slides left as the silences before it disappear.
      const removedBefore = (index: number) =>
        SILENCES.reduce((sum, [from, to]) => (index >= to ? sum + (to - from) : sum), 0);
      const step = width / BAR_COUNT;

      for (let i = 0; i < BAR_COUNT; i += 1) {
        const silent = isSilent(i);
        // Breathing keeps the idle phase from reading as a static image.
        const breathe = 1 + 0.06 * Math.sin(now / 900 + i / 5);
        const amplitude = silent ? 0.06 : seededHeight(i) * breathe;

        // A silent bar shrinks to nothing; a kept bar slides into its place.
        const shrink = silent ? 1 - collapsed : 1;
        const shift = removedBefore(i) * step * collapsed;
        const x = i * step - shift;
        if (x < -step || x > width) continue;

        const barHeight = Math.max(1, amplitude * shrink * height * 0.34);

        // Kept audio is brand purple; a silence about to go turns cold and
        // fades, so the eye follows what is being removed.
        const alpha = silent ? 0.5 * (1 - collapsed) * (1 - 0.45 * marked) : 0.55;
        const hue = silent ? `rgba(148,163,184,${alpha})` : `rgba(155,107,255,${alpha})`;

        const gradient = ctx.createLinearGradient(0, centreY - barHeight, 0, centreY + barHeight);
        gradient.addColorStop(0, "rgba(108,59,255,0)");
        gradient.addColorStop(0.5, hue);
        gradient.addColorStop(1, "rgba(108,59,255,0)");

        ctx.fillStyle = gradient;
        ctx.fillRect(x, centreY - barHeight, barWidth, barHeight * 2);
      }

      // A playhead sweeping the timeline while it plays, gone once the cut
      // begins. Radial rather than a band: a linear gradient inside a fillRect
      // has hard top and bottom edges, and a glowing rectangle reads as a
      // rendering mistake rather than as light.
      if (collapsed < 0.05 && t < 0.46) {
        const sweep = (t / 0.46) * width;
        const radius = height * 0.55;
        const glow = ctx.createRadialGradient(sweep, centreY, 0, sweep, centreY, radius);
        const strength = 0.14 * Math.min(1, t / 0.06) * Math.min(1, (0.46 - t) / 0.06);
        glow.addColorStop(0, `rgba(192,132,252,${strength})`);
        glow.addColorStop(1, "rgba(192,132,252,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(sweep - radius, centreY - radius, radius * 2, radius * 2);
      }

      frame = requestAnimationFrame(draw);
    };

    if (reducedMotion) {
      // The shape, none of the movement. Drawn once at the idle point, and
      // again on resize so it does not stretch.
      const drawStatic = () => {
        ctx.clearRect(0, 0, width, height);
        const barWidth = Math.max(2, width / BAR_COUNT - BAR_GAP);
        const centreY = height / 2;
        const step = width / BAR_COUNT;
        for (let i = 0; i < BAR_COUNT; i += 1) {
          const silent = isSilent(i);
          const barHeight = Math.max(1, (silent ? 0.06 : seededHeight(i)) * height * 0.34);
          const gradient = ctx.createLinearGradient(0, centreY - barHeight, 0, centreY + barHeight);
          gradient.addColorStop(0, "rgba(108,59,255,0)");
          gradient.addColorStop(0.5, silent ? "rgba(148,163,184,0.3)" : "rgba(155,107,255,0.5)");
          gradient.addColorStop(1, "rgba(108,59,255,0)");
          ctx.fillStyle = gradient;
          ctx.fillRect(i * step, centreY - barHeight, barWidth, barHeight * 2);
        }
      };
      drawStatic();
      const onResize = () => {
        resize();
        drawStatic();
      };
      observer.disconnect();
      const staticObserver = new ResizeObserver(() => {
        resize();
        drawStatic();
      });
      staticObserver.observe(canvas);
      return () => staticObserver.disconnect();
    }

    frame = requestAnimationFrame(draw);

    // Nothing should burn a phone battery while the tab is in the background.
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame);
      } else {
        frame = requestAnimationFrame(draw);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [showCanvas, reducedMotion]);

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
      {!showCanvas && (
        <video
          src={videoSrc}
          poster={posterSrc}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          onError={() => setVideoFailed(true)}
          className="w-full h-full object-cover opacity-[0.28]"
          data-testid="hero-video"
        />
      )}

      {showCanvas && (
        <div className="absolute inset-x-0 top-[6%] h-[36%] min-h-[280px]">
          <canvas
            ref={canvasRef}
            className="w-full h-full opacity-[0.6]"
            data-testid="hero-canvas"
          />
        </div>
      )}

      {/* The headline has to stay the most legible thing on the page, so the
          middle of the frame is pushed down and the edges are faded out. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 42% 20% at 50% 26%, rgba(6,3,16,0.9) 0%, rgba(6,3,16,0.5) 55%, transparent 100%)",
        }}
      />
      <div
        className="absolute inset-x-0 bottom-0 h-40"
        style={{ background: "linear-gradient(to bottom, transparent, rgba(6,3,16,1))" }}
      />
    </div>
  );
}
