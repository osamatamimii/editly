/**
 * Everything the bar used to hold, behind three lines.
 *
 * The header carried a logo, four section links, a language switch, "Log in"
 * and "Sign up free" — seven things competing with each other, and with the one
 * thing the page now asks somebody to do, which is type in the box under the
 * headline. Osama's call: the bar keeps the door and the menu, and the rest
 * moves in here.
 *
 * It is a drawer at **every** width, not a phone fallback. Below `lg` those
 * four links were not collapsed into anything — they were simply `hidden`, so
 * a person on a phone could not reach Pricing at all. A menu that exists on
 * one screen size and vanishes on another is two navigations; this is one.
 *
 * ## What a drawer has to get right
 *
 * Four things, and each of them is the difference between a menu and a box
 * that appears:
 *
 *   - **Escape closes it**, because that is the key everybody presses and a
 *     panel that ignores it feels stuck rather than modal.
 *   - **Focus goes in and comes back.** Opening moves focus to the first link,
 *     so a keyboard lands where the menu is rather than continuing down the
 *     page behind it; closing returns focus to the button that opened it, so
 *     the reader is not dropped at the top of the document.
 *   - **The page behind does not scroll.** A drawer over a scrolling page is
 *     how somebody closes the menu and finds themselves somewhere else.
 *   - **It opens from the side the language reads towards.** `inset-inline-end`
 *     rather than `right`, so Arabic gets it on the left without a second
 *     stylesheet.
 */
import { useEffect, useRef } from "react";
import { Link } from "wouter";
import { Menu, X } from "lucide-react";
import { LANDING } from "@/lib/landing-copy";
import type { Phrase } from "@/lib/landing-copy";

export interface NavDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Translate a phrase in the page's current language. */
  t: (phrase: Phrase) => string;
  rtl: boolean;
  chooseLanguage: (language: "en" | "ar") => void;
  signedIn: boolean;
}

const SECTIONS = [
  { href: "#features", label: LANDING.nav.features },
  { href: "#podcasts", label: LANDING.nav.podcasts },
  { href: "#how-it-works", label: LANDING.nav.howItWorks },
  { href: "#pricing", label: LANDING.nav.pricing },
];

export function NavMenuButton({
  open,
  onClick,
  label,
}: {
  open: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="button-menu"
      aria-label={label}
      aria-expanded={open}
      aria-controls="landing-menu"
      className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-md text-foreground/85 hover:text-foreground hover:bg-surface-1 transition-colors"
    >
      {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
    </button>
  );
}

export function NavDrawer({ open, onOpenChange, t, rtl, chooseLanguage, signedIn }: NavDrawerProps) {
  const panel = useRef<HTMLDivElement | null>(null);
  const first = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    if (!open) return;

    /*
      The page behind, held still.

      `overflow: hidden` on the element that actually scrolls, restored to
      whatever it was rather than to "" — this page sets its own overflow
      during the scroll glide, and clearing it here would undo that instead of
      putting it back.
    */
    const root = document.documentElement;
    const had = root.style.overflow;
    root.style.overflow = "hidden";

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);

    // Into the menu, not past it. A keyboard that opens a drawer and then
    // carries on down the page behind it has opened nothing.
    const came = document.activeElement as HTMLElement | null;
    first.current?.focus();

    return () => {
      root.style.overflow = had;
      window.removeEventListener("keydown", onKey);
      /*
        And back to whatever opened it.

        Without this, closing leaves focus on a button that no longer exists,
        which browsers resolve by moving to `<body>` — so the next Tab starts
        at the top of the document and a keyboard reader is silently returned
        to the beginning of a page they had already navigated.
      */
      came?.focus?.();
    };
  }, [open, onOpenChange]);

  if (!open) return null;

  const close = () => onOpenChange(false);

  return (
    <div className="fixed inset-0 z-[60]" data-testid="landing-menu-root">
      {/* The page, dimmed and answerable. A backdrop that cannot be clicked is
          a decoration in front of a page somebody can no longer reach. */}
      <button
        type="button"
        aria-label={t(LANDING.nav.close)}
        data-testid="button-menu-backdrop"
        onClick={close}
        className="absolute inset-0 w-full h-full bg-[rgba(3,7,14,0.62)] backdrop-blur-sm animate-fade-in"
      />
      <div
        id="landing-menu"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={t(LANDING.nav.menu)}
        data-testid="landing-menu"
        /* From the side the language reads towards: `inset-inline-end` is the
           right edge in English and the left in Arabic, with no second rule. */
        /*
          An opaque ground, and this is the bug the first version had.

          `bg-surface-1` is `rgba(255,255,255,0.05)` — a *raised* surface,
          meant to sit on the page and pick up what is behind it. A drawer does
          not sit on the page, it covers it, and at five per cent white the
          header's own CTA ghosted through the panel's top corner: a blue pill
          floating inside the menu, belonging to a bar the menu was covering.

          So the page's own ground, at full opacity, with a raised surface laid
          over it for the tint the rest of the system has. Two layers rather
          than one token because there is no opaque equivalent of `surface-1`
          in the palette, and inventing one for a single component is how a
          design system acquires a colour nobody else can use.
        */
        className="absolute inset-y-3 w-[min(86vw,320px)] rounded-3xl overflow-hidden bg-background border border-hairline shadow-[0_0_60px_rgba(3,7,14,0.6)] flex flex-col p-6 gap-1 animate-fade-in"
        /*
          A panel with corners, not a slab against the edge.

          It was `inset-y-0` with one border down its inner side: a rectangle
          butted into the corner of the window, which is the one shape nothing
          else on this page is. Everything here is held off its ground and
          rounded — the bar is a capsule, the box in the hero is `rounded-3xl`,
          the cards in the row below are 24px — so a drawer with two square
          corners reads as a different product's menu.

          Inset on all four sides and rounded to match the box it is a sibling
          of. `overflow-hidden` because the tint layer underneath fills the
          panel and would otherwise square off the corners it sits in.

          `inset-inline-end` as a style rather than a class: Tailwind has
          `end-3`, and it resolves against the *element's* direction, inherited
          from a document that is `rtl` on the Arabic page. The property says
          the same thing and says it once.
        */
        style={{ insetInlineEnd: "0.75rem" }}
      >
        <div aria-hidden className="absolute inset-0 bg-surface-1 pointer-events-none" />
        <div className="relative flex items-center justify-between mb-4">
          <span className="text-sm font-semibold text-muted-foreground">{t(LANDING.nav.menu)}</span>
          <button
            type="button"
            onClick={close}
            data-testid="button-menu-close"
            aria-label={t(LANDING.nav.close)}
            className="min-h-[44px] min-w-[44px] -me-2 inline-flex items-center justify-center rounded-md text-foreground/85 hover:text-foreground hover:bg-surface-2 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {SECTIONS.map((item, index) => (
          <a
            key={item.href}
            ref={index === 0 ? first : undefined}
            href={item.href}
            onClick={close}
            data-testid={`menu-${item.href.slice(1)}`}
            className="relative min-h-[48px] flex items-center rounded-md px-3 -mx-3 text-base font-medium text-foreground/90 hover:text-foreground hover:bg-surface-2 transition-colors"
          >
            {t(item.label)}
          </a>
        ))}

        <div className="relative my-3 h-px bg-hairline" />

        {/*
          The language switch, still a word rather than a globe.

          A globe is the international symbol for "a menu you have to open to
          find out what is in it", and this one is already inside a menu. There
          are two languages, so the control says the other one in its own
          script — and `lang` on the button is the language of its *label*, so
          the browser reaches for the right face for those letters.
        */}
        <button
          type="button"
          onClick={() => {
            chooseLanguage(rtl ? "en" : "ar");
            close();
          }}
          data-testid="button-language"
          lang={rtl ? "en" : "ar"}
          title={t(LANDING.languageToggle.title)}
          className="relative min-h-[48px] min-w-[44px] flex items-center rounded-md px-3 -mx-3 text-base font-medium text-foreground/90 hover:text-foreground hover:bg-surface-2 transition-colors"
        >
          {t(LANDING.languageToggle.label)}
        </button>

        {/* Signed in, the only door is the one in the bar; there is nothing to
            log in to from here. */}
        {signedIn ? null : (
          <Link
            href="/login"
            data-testid="link-log-in"
            onClick={close}
            className="relative min-h-[48px] flex items-center rounded-md px-3 -mx-3 text-base font-medium text-foreground/90 hover:text-foreground hover:bg-surface-2 transition-colors"
          >
            {t(LANDING.header.logIn)}
          </Link>
        )}
      </div>
    </div>
  );
}
