import { AlertCircle } from "lucide-react";
import { BackButton } from "@/components/back-button";
import { useLanguage } from "@/lib/language";
import { NOT_FOUND } from "@/lib/copy/chrome";
import { COMMON } from "@/lib/copy/common";
import { directionOf } from "@/lib/landing-copy";

/**
 * The 404. It used to ask "Did you forget to add the page to the router?" on a
 * light grey card — a note from a developer to themselves, shown to whoever
 * mistyped a URL. It now says what happened and offers the two ways out.
 */
export default function NotFound() {
  const { t, language } = useLanguage();

  return (
    /*
      The one screen that sets its own `lang` and `dir`, and the reason is that
      it has no route of its own. `BILINGUAL` is a list of paths, and this
      answers at whatever address was mistyped — so the provider, which decides
      from the path, has no way to know that what it is about to render is this
      and not a screen with English on it. Written in both languages, it says so
      itself, on its own wrapper, exactly as the landing page does.
    */
    <div
      lang={language}
      dir={directionOf(language)}
      className="min-h-screen w-full flex flex-col items-center justify-center gap-4 px-6 text-center"
    >
      <div className="w-14 h-14 rounded-full bg-surface-1 border border-hairline flex items-center justify-center">
        <AlertCircle className="w-7 h-7 text-muted-foreground" />
      </div>
      <h1 className="text-2xl font-bold">{t(NOT_FOUND.title)}</h1>
      <p className="text-muted-foreground max-w-sm">{t(NOT_FOUND.detail)}</p>
      <div className="flex items-center gap-2 mt-2">
        <BackButton fallback="/" label={t(COMMON.back)} variant="outline" testId="button-back-404" />
      </div>
    </div>
  );
}
