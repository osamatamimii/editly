import { useLocation } from "wouter";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/language";
import { COMMON } from "@/lib/copy/common";
import { directionOf } from "@/lib/landing-copy";

/**
 * Go back one page.
 *
 * Prefers the browser's own history, because "back" should mean the page you
 * actually came from — a fixed destination sends someone who arrived at the
 * editor from an export screen to the dashboard instead, which is not where
 * they were. When there is no history to go back to (a shared link, a fresh
 * tab, a reload), it falls back to the sensible parent for this page rather
 * than leaving a button that does nothing.
 */
export function BackButton({
  fallback,
  label,
  className = "",
  variant = "ghost",
  testId = "button-back",
}: {
  /** Where to go when this page was opened directly. */
  fallback: string;
  /** Omit for the icon-only form. */
  label?: string;
  className?: string;
  variant?: "ghost" | "outline";
  testId?: string;
}) {
  const [, setLocation] = useLocation();
  const { t, screenLanguage } = useLanguage();
  /*
    The arrow points at where it goes, which is not the same side in both
    languages. This is the bug `lib/language.tsx` measured: on an Arabic screen
    a left chevron sits on the right of the button and points away from the
    page it returns to. Chosen here rather than mirrored in CSS because it is
    one arrow and a transform on an icon is a thing somebody has to notice
    later when they change the icon.
  */
  const Chevron = directionOf(screenLanguage) === "rtl" ? ChevronRight : ChevronLeft;

  const goBack = () => {
    // history.length counts the whole tab's session, so it can be greater than
    // one even when this page is the first thing this app rendered. The state
    // wouter pushes on navigation is the honest signal that a step exists.
    const hasHistory = window.history.length > 1 && window.history.state !== null;
    if (hasHistory) {
      window.history.back();
      return;
    }
    setLocation(fallback);
  };

  if (!label) {
    return (
      <Button
        variant={variant}
        size="icon"
        onClick={goBack}
        aria-label={t(COMMON.back)}
        className={`text-muted-foreground hover:text-foreground ${className}`}
        data-testid={testId}
      >
        <Chevron className="w-5 h-5" />
      </Button>
    );
  }

  return (
    <Button
      variant={variant}
      onClick={goBack}
      className={`text-muted-foreground hover:text-foreground ${className}`}
      data-testid={testId}
    >
      <Chevron className="w-4 h-4 me-2" />
      {label}
    </Button>
  );
}
