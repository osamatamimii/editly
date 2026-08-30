/**
 * The control that switches the theme.
 *
 * One button rather than a dropdown, because there are three states and a menu
 * for three states costs two clicks to do what one click can. It cycles
 * light → dark → system, and the icon is the *current* state rather than the
 * next one: a button that shows where you are going is a riddle, and every
 * implementation that does it gets bug reports saying the icon is backwards.
 *
 * The label under the tooltip says which of the three is on, including
 * "Following your system" — otherwise there is no way to tell the difference
 * between "dark because I chose dark" and "dark because it is 9pm".
 */
import { Moon, Sun, MonitorSmartphone } from "lucide-react";
import { useTheme, type ThemePreference } from "@/lib/theme";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const LABELS: Record<ThemePreference, string> = {
  light: "Light",
  dark: "Dark",
  system: "Following your system",
};

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { preference, theme, cycle } = useTheme();

  const Icon = preference === "system" ? MonitorSmartphone : preference === "light" ? Sun : Moon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={cycle}
          data-testid="button-theme-toggle"
          // The accessible name carries the state, because the icon alone is
          // not a name and a screen reader user gets nothing from "button".
          aria-label={`Theme: ${LABELS[preference]}. Click to change.`}
          className={`w-11 h-11 sm:w-9 sm:h-9 rounded-full flex items-center justify-center border border-hairline bg-surface-1 text-muted-foreground transition-all duration-300 hover:text-foreground hover:bg-surface-2 hover:border-hairline-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${className}`}
        >
          <Icon className="w-4 h-4" />
          <span className="sr-only">
            {LABELS[preference]}
            {preference === "system" ? ` (currently ${theme})` : ""}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{LABELS[preference]}</TooltipContent>
    </Tooltip>
  );
}
