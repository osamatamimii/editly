/**
 * The words more than one screen has to agree on, and the two sentences a
 * screen says when it could not read something.
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

export const COMMON = {
  cancel: p("إلغاء", "Cancel"),
  save: p("حفظ", "Save"),
  saving: p("عم يحفظ…", "Saving…"),
  saved: p("انحفظ", "Saved"),
  delete: p("حذف", "Delete"),
  remove: p("إزالة", "Remove"),
  close: p("إغلاق", "Close"),
  done: p("تمّ", "Done"),
  back: p("رجوع", "Back"),
  next: p("التالي", "Next"),
  retry: p("جرّب كمان مرّة", "Retry"),
  tryAgain: p("جرّب مرّة تانية", "Try again"),
  loading: p("عم يحمّل…", "Loading…"),
  copy: p("نسخ", "Copy"),
  copied: p("انتسخ", "Copied"),
  download: p("تنزيل", "Download"),
  open: p("فتح", "Open"),
  edit: p("تعديل", "Edit"),
  confirm: p("تأكيد", "Confirm"),
  dismiss: p("تجاهل", "Dismiss"),
  skip: p("تخطّى", "Skip"),
  continue: p("متابعة", "Continue"),
  signIn: p("تسجيل الدخول", "Log in"),
  signOut: p("تسجيل الخروج", "Log out"),
  dashboard: p("لوحتك", "Dashboard"),
  account: p("الحساب", "Account"),
  project: p("مشروع", "Project"),
  projects: p("المشاريع", "Projects"),
  minutes: p("دقايق", "minutes"),
  seePlans: p("اعرض الخطط", "See plans"),
  upgrade: p("ترقية", "Upgrade"),
} as const;

  /**
   * What a screen says when it could not read something.
   *
   * The 12 August rule, in two languages now: it must not read as an empty
   * state, and it must say the work is safe. Somebody who believes their videos
   * are gone does not retry, they re-upload, or they leave.
   */
export const LOAD = {
  couldNotLoad: p(
    "ما قدرنا نقرا هاد. شغلك سليم، والخلل عنّا.",
    "We couldn't load this. Your work is safe. This is on our side.",
  ),
  failedTitle: f<[string]>((what) => `ما قدرنا نحمّل ${what}`, (what) => `We couldn't load ${what}`),
  failedCompact: f<[string]>((what) => `ما قدرنا نحمّل ${what}`, (what) => `Couldn't load ${what}`),
  /** The thing that failed, named in the person's words by whoever asked. */
  yourProjects: p("مشاريعك", "your projects"),
  theseNumbers: p("هالأرقام", "these numbers"),
  thisProject: p("هالمشروع", "this project"),
  theConversation: p("المحادثة", "the conversation"),
  yourClips: p("مقاطعك", "your clips"),
  yourAccounts: p("حساباتك", "your accounts"),
  yourPosts: p("منشوراتك", "your posts"),
  yourFonts: p("خطوطك", "your fonts"),
  theResults: p("النتائج", "the results"),
} as const;

  /**
   * What the server just refused, as a category.
   *
   * The *sentence* stays the server's — it knows the minutes, the plan and the
   * length, and it is already written in both languages. Only the title is
   * here, because the title is the category and the category decides whether a
   * button appears beside it.
   */
export const REFUSAL = {
  paidFeature: p("هاي ميزة مدفوعة", "That's a paid feature"),
  alreadyRendering: p("في تنفيذ شغّال", "Already rendering"),
  tooLongForPlan: p("هالملف أطول من اللي بتسمح فيه خطّتك", "That file is too long for this plan"),
  notEnoughMinutes: p("ما ضلّ دقايق كفاية", "Not enough minutes left"),
  renderInProgress: p("هالمشروع عليه تنفيذ شغّال.", "This project has a render in progress."),
} as const;
