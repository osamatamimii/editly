/**
 * The library, which is the screen people open every day.
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
   * The library, which is the screen people open every day.
   *
   * The status words are the ones that matter here. They sit on a badge over
   * somebody's own footage and they are the only thing on the card that says
   * whether anything is happening, so each one has to be a word rather than a
   * phrase: «جاهز» and «يُنفَّذ» read at a glance, and a two-word Arabic
   * translation of "Processing" would wrap on a phone.
   */
export const DASHBOARD = {
  title: p("المشاريع", "Projects"),
  signature: p("توقّف عن المونتاج. ابدأ بالوصف.", "Stop editing. Start describing."),

  operations: p("التشغيل", "Operations"),
  clips: p("المقاطع", "Clips"),
  scheduled: p("المجدولة", "Scheduled"),
  newProject: p("مشروع جديد", "New Project"),

  statProjectsShort: p("المشاريع", "Projects"),
  statProjects: p("إجمالي المشاريع", "Total Projects"),
  statWorkingShort: p("قيد العمل", "Working"),
  statWorking: p("عم يتنفّذ", "Currently Processing"),
  statDoneShort: p("منتهية", "Done"),
  statDone: p("التعديلات المنتهية", "Completed Edits"),
  /** Named for the tile it sits in, because "this" is what a tile is. */
  thisNumber: p("هالرقم", "this"),
  waitingTheirTurn: p("مستنية دورها", "waiting their turn"),
  waitingForMachine: p("مستنية جهاز", "waiting for a machine"),

  statusStalled: p("مستنية جهاز", "Waiting for a machine"),
  statusStalledTitle: p(
    "التنفيذ بالطابور، وما التقطه أي جهاز لسا.",
    "The render is queued, but no machine has picked it up.",
  ),
  statusUploading: p("عم يترفع", "Uploading"),
  statusReady: p("جاهز", "Ready"),
  statusProcessing: p("عم يتنفّذ", "Processing"),
  statusDone: p("تمّ", "Done"),
  statusFailed: p("فشل", "Failed"),

  deleteProject: f<[string]>((title) => `احذف ${title}`, (title) => `Delete ${title}`),
  projectDeleted: p("انحذف المشروع", "Project deleted"),
  projectDeletedDetail: p("شلنا المشروع.", "The project has been removed."),
  deleteFailed: p("ما قدرنا نحذف المشروع", "Failed to delete project"),
  tryLater: p("جرّب بعدين.", "Please try again later."),
  createFailed: p("ما قدرنا نفتح المشروع", "Failed to create project"),
  limitReached: p("خلصت دقايق خطّتك", "Video limit reached"),
  limitReachedDetail: f<[string, string]>(
    (minutes, plan) => `خلّصت كل دقايق التصدير (${minutes}) بخطّة ${plan} هالشهر.`,
    (minutes, plan) => `You've used all ${minutes} exported minutes on your ${plan} plan this month.`,
  ),
  badFileType: p("نوع ملف غير مدعوم", "Invalid file type"),
  badFileTypeDetail: p("ارفع ملفّ mp4 أو mov أو webm.", "Please upload an mp4, mov, or webm file."),
  fileTooLarge: p("الملف كبير", "File too large"),
  fileTooLargeDetail: f<[string, string]>(
    (size, ceiling) => `حجم الملفّ ${size}. والحدّ الحالي ${ceiling} للفيديو الواحد.`,
    (size, ceiling) => `That file is ${size}. The current limit is ${ceiling} per video.`,
  ),

  freeBandDetail: f<[number, number]>(
    (minutes, upload) =>
      `${minutes} دقايق فيديو جاهز بالشهر، ورفع لحدّ ${upload} دقايق، وكل ميزات التعديل. بلا بطاقة وبلا انتهاء. بتشتغل وبس.`,
    (minutes, upload) =>
      `${minutes} minutes of finished video a month, uploads up to ${upload} minutes, and every editing feature. No card, no expiry. It simply keeps working.`,
  ),
  usageBand: p("دقيقة فيديو جاهز هالشهر", "minutes of finished video this month"),
  planBadge: f<[string]>((plan) => `خطّة ${plan}`, (plan) => `${plan} plan`),

  podcastsTitle: p("البودكاست والتسجيلات الطويلة", "Podcasts and long recordings"),
  podcastsHint: p("افتح واحد وقصّ منه مقاطع", "open one to cut clips out of it"),
  /*
    Where the cutting happens, said on the section that holds the recordings.

    The two screens were reachable from each other only by accident: this one
    lists the episodes, the other one extracts from them, and nothing on either
    pointed at the other. Somebody with an episode in front of them had to
    already know that "Clips" was a verb.
  */
  podcastsToClips: p("قسم استخراج المقاطع", "Clip extraction"),
  everythingElse: p("ما تبقّى", "Everything else"),
  recentProjects: p("أحدث المشاريع", "Recent Projects"),

  emptyTitle: p("لا شيء هنا بعد", "Nothing here yet"),
  emptyLead: p(
    "ارفع تسجيل خام وقول لـEditly شو بدك يعمل فيه. بطّل تمنتج، وابدا تحكي.",
    "Upload a raw take and tell Editly what you want done with it. Stop editing, start describing.",
  ),
  createProject: p("افتح مشروع", "Create Project"),

  createTitle: p("مشروع جديد", "Create New Project"),
  createLead: p("ابدا من الفيديو، أو بس سمّي المشروع.", "Start from your video, or just give the project a name."),
  dropHere: p("رمي الفيديو هون", "Drop your video here"),
  dropHint: p(
    "المشروع بيسمّي حاله والرفع بيبلّش على طول",
    "The project names itself and the upload starts right away",
  ),
  orNameFirst: p("أو سمّيه أوّل", "or name it first"),
  projectName: p("اسم المشروع", "Project Name"),
  projectNameHint: p("متلًا: مقطعي القصير", "e.g. My Viral Short"),
} as const;
