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
  statWorking: p("قيد التنفيذ الآن", "Currently Processing"),
  statDoneShort: p("منتهية", "Done"),
  statDone: p("التعديلات المنتهية", "Completed Edits"),
  /** Named for the tile it sits in, because "this" is what a tile is. */
  thisNumber: p("هذا الرقم", "this"),
  waitingTheirTurn: p("في انتظار دورها", "waiting their turn"),
  waitingForMachine: p("تنتظر جهازًا", "waiting for a machine"),

  statusStalled: p("بانتظار جهاز", "Waiting for a machine"),
  statusStalledTitle: p(
    "التنفيذ في الطابور، ولم يلتقطه أي جهاز بعد.",
    "The render is queued, but no machine has picked it up.",
  ),
  statusUploading: p("يُرفع", "Uploading"),
  statusReady: p("جاهز", "Ready"),
  statusProcessing: p("يُنفَّذ", "Processing"),
  statusDone: p("تمّ", "Done"),
  statusFailed: p("فشل", "Failed"),

  deleteProject: f<[string]>((title) => `احذف ${title}`, (title) => `Delete ${title}`),
  projectDeleted: p("حُذف المشروع", "Project deleted"),
  projectDeletedDetail: p("أُزيل المشروع.", "The project has been removed."),
  deleteFailed: p("تعذّر حذف المشروع", "Failed to delete project"),
  tryLater: p("حاول لاحقًا.", "Please try again later."),
  createFailed: p("تعذّر إنشاء المشروع", "Failed to create project"),
  limitReached: p("انتهت دقائق خطّتك", "Video limit reached"),
  limitReachedDetail: f<[string, string]>(
    (minutes, plan) => `استهلكت كل دقائق التصدير (${minutes}) في خطّة ${plan} هذا الشهر.`,
    (minutes, plan) => `You've used all ${minutes} exported minutes on your ${plan} plan this month.`,
  ),
  badFileType: p("نوع ملف غير مدعوم", "Invalid file type"),
  badFileTypeDetail: p("ارفع ملف mp4 أو mov أو webm.", "Please upload an mp4, mov, or webm file."),
  fileTooLarge: p("الملف كبير", "File too large"),
  fileTooLargeDetail: f<[string, string]>(
    (size, ceiling) => `حجم الملف ${size}. والحدّ الحالي ${ceiling} للفيديو الواحد.`,
    (size, ceiling) => `That file is ${size}. The current limit is ${ceiling} per video.`,
  ),

  freeBandDetail: f<[number, number]>(
    (minutes, upload) =>
      `${minutes} دقائق فيديو منتهٍ في الشهر، ورفع حتى ${upload} دقائق، وكل ميزات التعديل. بلا بطاقة وبلا انتهاء. تعمل وحسب.`,
    (minutes, upload) =>
      `${minutes} minutes of finished video a month, uploads up to ${upload} minutes, and every editing feature. No card, no expiry. It simply keeps working.`,
  ),
  usageBand: p("دقيقة فيديو منتهٍ هذا الشهر", "minutes of finished video this month"),
  planBadge: f<[string]>((plan) => `خطّة ${plan}`, (plan) => `${plan} plan`),

  podcastsTitle: p("البودكاست والتسجيلات الطويلة", "Podcasts and long recordings"),
  podcastsHint: p("افتح واحدًا لتقصّ منه مقاطع", "open one to cut clips out of it"),
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
    "ارفع تسجيلًا خامًا وقل لـEditly ما تريد أن يفعل به. توقّف عن المونتاج، وابدأ بالوصف.",
    "Upload a raw take and tell Editly what you want done with it. Stop editing, start describing.",
  ),
  createProject: p("أنشئ مشروعًا", "Create Project"),

  createTitle: p("مشروع جديد", "Create New Project"),
  createLead: p("ابدأ من الفيديو، أو سمِّ المشروع فقط.", "Start from your video, or just give the project a name."),
  dropHere: p("أفلت الفيديو هنا", "Drop your video here"),
  dropHint: p(
    "المشروع يسمّي نفسه ويبدأ الرفع فورًا",
    "The project names itself and the upload starts right away",
  ),
  orNameFirst: p("أو سمِّه أوّلًا", "or name it first"),
  projectName: p("اسم المشروع", "Project Name"),
  projectNameHint: p("مثلًا: مقطعي القصير", "e.g. My Viral Short"),
} as const;
