/**
 * The export screen.
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

  /**
   * The export screen.
   *
   * Platform names stay in Latin script — TikTok, Reels, Shorts are what they
   * are called in Arabic too — and so do the aspect ratios, which are read as
   * numbers rather than words in both languages.
   */
export const EXPORT = {
  title: p("تصدير المشروع", "Export Project"),
  notFound: p("لم يُعثر على المشروع", "Project not found"),

  loadingVideo: p("نحمّل فيديوك…", "Loading your video…"),
  previewFailed: p("تعذّر تحميل المعاينة", "We could not load the preview"),
  previewFailedDetail: p(
    "فيديوك محفوظ بأمان. الخلل عندنا، والتصدير يعمل.",
    "Your video is stored safely. This is a problem on our side, and exporting still works.",
  ),
  noVideo: p("لا فيديو لتصديره", "No video available to export"),
  wontPreview: p("هذا الملف لا يُعرض هنا", "This file will not preview here"),
  wontPreviewDetail: p(
    "ينزل سليمًا ويُنشر سليمًا. هذا المتصفّح لا يستطيع رسمه.",
    "It downloaded fine and it posts fine. This browser cannot draw it.",
  ),

  checkingTitle: p("نتحقّق من وجود تنفيذ جارٍ", "Checking for a render in progress"),
  checkingLead: p(
    "لحظة. أن نعرض عليك بدء تصدير وواحدٌ يعمل بالفعل هو الطريق إلى أن يُقال لك إنه فشل.",
    "One moment. Offering to start an export while one is already running is how you end up being told it failed.",
  ),

  pickTitle: p("اختر مقاس المنصّة", "Select Platform Format"),
  pickLead: p(
    "سيضبط الذكاء الاصطناعي التأطير والدقّة للمنصّة التي تختارها.",
    "AI will optimize the framing and resolution for your chosen platform.",
  ),
  vertical: p("‏9:16 عمودي", "9:16 Vertical"),
  renderAndExport: p("نفّذ وصدّر", "Render & Export"),

  renderingTitle: p("يُنفَّذ الفيديو", "Rendering Video"),
  renderingLead: f<[string]>(
    (platform) => `اللمسات الأخيرة والتنسيق لـ${platform}.`,
    (platform) => `Applying final AI touches and formatting for ${platform}.`,
  ),

  readyTitle: p("جاهز للنشر", "Ready to Share"),
  readyLead: f<[string]>(
    (platform) => `ضُبط فيديوك لـ${platform}.`,
    (platform) => `Your video has been successfully optimized for ${platform}.`,
  ),
  preparingFile: p("نجهّز ملفك…", "Preparing your file…"),
  gettingReady: p("نجهّزه…", "Getting it ready…"),
  downloadVideo: p("نزّل الفيديو", "Download Video"),
  downloadStarted: p("بدأ التنزيل", "Download started"),
  downloadStartedDetail: p("فيديوك يُنزَّل الآن.", "Your video is downloading."),
  whatWeDid: p("ما فعلناه", "What we did"),
  anotherFormat: p("صدّر بمقاس آخر", "Export Another Format"),

  complete: p("تمّ التصدير", "Export Complete!"),
  completeDetail: p("فيديوك جاهز للتنزيل.", "Your video is ready to download."),
  failed: p("فشل التصدير", "Export Failed"),
  failedDetail: p("حدث خطأ. حاول مرّة أخرى.", "Something went wrong. Please try again."),
  couldNotStart: p("تعذّر بدء التصدير", "Could not start export"),
} as const;
