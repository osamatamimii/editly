/**
 * Dates, in the language the screen is in.
 *
 * Two things were happening before this, and neither of them was a decision.
 * The project card formatted `MMM d, yyyy` with no locale, so it said "Aug 24,
 * 2026" on a screen that had just been translated into Arabic. Everywhere else
 * called `toLocaleString()` with no argument, which follows the *browser's*
 * language rather than the product's — so the same page could show an Arabic
 * label above an English date, or an English label above a French one, and the
 * only person who ever sees the inconsistent pair is the customer.
 *
 * ## Latin digits, in both languages
 *
 * `toLocaleString("ar")` renders ٢٤ rather than 24, and that is the right
 * answer for a paragraph of Arabic prose and the wrong one here. This product
 * is mostly numbers that sit beside other numbers — a duration, a resolution,
 * a price, a queue position — and half of those are Latin whatever happens,
 * because they come from a platform or a file. Mixed numerals in one row is
 * harder to read than either alone, and it is the sort of thing that looks
 * like a rendering bug rather than a choice.
 *
 * `date-fns`'s Arabic locale writes Latin digits with Arabic month names,
 * which is the arrangement this product wants, so it is what is used rather
 * than `Intl` with a numbering-system override.
 */
import { format } from "date-fns";
import { ar } from "date-fns/locale";
import type { Language } from "@/lib/landing-copy";
import { useLanguage } from "@/lib/language";

const localeFor = (language: Language) => (language === "ar" ? { locale: ar } : undefined);

/** A day, the way a card says it: "24 Aug 2026" / «24 أغسطس 2026». */
export function formatDay(at: Date | string | number, language: Language): string {
  return format(new Date(at), language === "ar" ? "d MMMM yyyy" : "MMM d, yyyy", localeFor(language));
}

/** A day and a time, for a queue: "24 Aug 2026, 09:30". */
export function formatMoment(at: Date | string | number, language: Language): string {
  return format(new Date(at), language === "ar" ? "d MMMM yyyy، HH:mm" : "MMM d, yyyy, HH:mm", localeFor(language));
}

/**
 * A day without its year, for an axis: "24 Aug" / «24 أغسطس».
 *
 * The full day is right on a card, where it is read once, and wrong along the
 * foot of a chart, where fourteen of them have to fit across a phone. The year
 * is the part that carries no information there: every point on a fortnight is
 * in the same one.
 */
export function formatShortDay(at: Date | string | number, language: Language): string {
  return format(new Date(at), language === "ar" ? "d MMM" : "d MMM", localeFor(language));
}

/** Just the clock, for something happening today. */
export function formatClock(at: Date | string | number, language: Language): string {
  return format(new Date(at), "HH:mm", localeFor(language));
}

/**
 * The same three, bound to the screen's language.
 *
 * A hook rather than three calls carrying `language` around, because every
 * caller is a component that already has the provider above it and the
 * argument is the same one every time.
 */
export function useDates() {
  const { language } = useLanguage();
  return {
    day: (at: Date | string | number) => formatDay(at, language),
    moment: (at: Date | string | number) => formatMoment(at, language),
    clock: (at: Date | string | number) => formatClock(at, language),
    shortDay: (at: Date | string | number) => formatShortDay(at, language),
  };
}
