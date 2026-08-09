import { useLocation } from "wouter";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

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
        aria-label="Back"
        className={`text-muted-foreground hover:text-foreground ${className}`}
        data-testid={testId}
      >
        <ChevronLeft className="w-5 h-5" />
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
      <ChevronLeft className="w-4 h-4 mr-2" />
      {label}
    </Button>
  );
}
