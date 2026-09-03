/**
 * The control that switches the language, inside the product.
 *
 * The landing page has had one since it was written, and until now that was the
 * only place in Editly where the choice could be made: somebody who signed up
 * from the Arabic page and then wanted English had to go back out to the
 * marketing site to change it. The preference has always been shared — one key,
 * `editly:language`, read by both halves — so this button is the missing half
 * of a seam that already existed rather than a second setting.
 *
 * Labelled in the language it switches *to*, exactly as on the landing page: the
 * Arabic product shows "English" and the English product shows العربية. A
 * control labelled with the state you are already in is a riddle, and everybody
 * who has ever built one gets told the label is backwards.
 *
 * Shaped like `ThemeToggle` on purpose. They sit next to each other on the
 * account screen and they are the same kind of thing: one button, one click, no
 * menu for two states.
 */
import { Languages } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLanguage } from "@/lib/language";
import { LANGUAGE } from "@/lib/copy/chrome";

export function LanguageToggle({ className = "" }: { className?: string }) {
  const { language, choose, t } = useLanguage();
  const next = language === "ar" ? "en" : "ar";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => choose(next)}
          data-testid="button-language-toggle"
          // The name carries the destination, because the icon is a glyph of
          // two scripts and says nothing about which one you are about to get.
          aria-label={t(LANGUAGE.title)}
          lang={next}
          className={`h-11 sm:h-9 px-3 rounded-full flex items-center gap-2 border border-hairline bg-surface-1 text-muted-foreground text-sm font-medium transition-all duration-300 hover:text-foreground hover:bg-surface-2 hover:border-hairline-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${className}`}
        >
          <Languages className="w-4 h-4" aria-hidden="true" />
          {t(LANGUAGE.label)}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{t(LANGUAGE.title)}</TooltipContent>
    </Tooltip>
  );
}
