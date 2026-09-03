/**
 * The furniture: the two settings controls, the crash screen, and the 404.
 *
 * One file per screen, and that is a bundling decision as much as a filing
 * one. The copy table was a single module, and a single module is a single
 * unit to a bundler: `not-found.tsx` and the crash screen are in the first
 * chunk the landing page downloads, so importing one sentence from that module
 * pulled every sentence in the product into it — measured at 17kB of gzip, in
 * a chunk `tools/speed-test.mjs` holds under 200kB. Split, each screen's words
 * travel in that screen's chunk.
 *
 * The rules are in `lib/app-copy.ts`, which is the door to this folder and
 * explains what is deliberately not written here.
 */
import { phrase as p, template as f } from "@/lib/landing-copy";

  /** The theme control, whose whole job is to say which of three states is on. */
export const THEME = {
  light: p("فاتح", "Light"),
  dark: p("داكن", "Dark"),
  system: p("يتبع نظامك", "Following your system"),
  currently: f<[string]>((now) => ` (الآن ${now})`, (now) => ` (currently ${now})`),
  aria: f<[string]>(
    (state) => `المظهر: ${state}. اضغط للتغيير.`,
    (state) => `Theme: ${state}. Click to change.`,
  ),
} as const;

  /**
   * The language control, inside the product.
   *
   * Labelled in the language it switches *to*, exactly as on the landing page,
   * so the pair is deliberately the wrong way round and the suite names it.
   */
export const LANGUAGE = {
  label: p("English", "العربية"),
  title: p("Read the product in English", "استعمل المنتج بالعربية"),
} as const;

  /**
   * The crash screen, which is the one screen that cannot use the provider.
   *
   * `ErrorBoundary` sits above `LanguageProvider` in `App.tsx`, and it has to:
   * a boundary inside the tree it is catching cannot render when that tree is
   * what threw. So it reads `storedLanguage()` directly. That is not a
   * shortcut around the seam, it is the one place the seam cannot reach.
   */
export const CRASH = {
  title: p("توقّفت هذه الشاشة", "This screen stopped working"),
  lead: p(
    "لم يضع شيء ممّا صنعته. مشاريعك وفيديوهاتك في مكانها.",
    "Nothing you made has been lost. Your projects and your videos are where they were.",
  ),
  stopped: p("توقّفت الصفحة على غير المتوقّع", "The page stopped unexpectedly"),
  reload: p("أعد تحميل الصفحة", "Reload the page"),
  quoteThis: p("إن تكرّر هذا، اذكر هذا الرمز: ", "If it keeps happening, quote this: "),
} as const;

  /** The 404. */
export const NOT_FOUND = {
  title: p("هذه الصفحة غير موجودة", "This page does not exist"),
  detail: p(
    "قد يكون الرابط قديمًا، أو العنوان فيه حرف زائد.",
    "The link may be out of date, or the address slightly off.",
  ),
} as const;
