/**
 * The clip library.
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
   * The clip-extraction screen.
   *
   * The words here changed for one reason: this section was being read as
   * "podcast editing", and it is not. It does one job, on one kind of input,
   * and the copy now says which. You point it at a long recording and it hands
   * back short posts. It does not edit an episode, it does not publish one, and
   * it is not where a two-hour take goes to be tidied.
   *
   * The title says the job rather than the artefact for the same reason. "Clips"
   * names what is on the screen; "take clips out of a recording" names what the
   * screen is for, and only one of those tells somebody standing in front of a
   * ninety-minute episode whether they are in the right place.
   */
export const CLIPS = {
  title: p("استخراج المقاطع", "Clip extraction"),
  lead: p(
    "أضف حلقة بودكاست هنا، وتعود بمقاطع قصيرة جاهزة للنشر. قسم واحد بعمل واحد: ليس تعديلًا للحلقة نفسها.",
    "Add a podcast episode here and it hands back short posts. One section, one job: it is not where the episode itself gets edited.",
  ),

  /*
    The door, which is what makes this a section rather than a shelf.

    "Add a podcast" and not "upload a file", because the second names what the
    browser does and the first names what the person came to do. The sentence
    under it says what happens next, in full, so that nobody has to press it to
    find out.
  */
  addTitle: p("أضف حلقة بودكاست", "Add a podcast episode"),
  addHint: p(
    "أفلت الملفّ هنا. يُرفَع، ويُكتب لك طلب القصّ في المحرّر، وترسله أنت.",
    "Drop the file here. It uploads, the request for clips is written into the editor, and you press send.",
  ),
  addButton: p("اختر ملفًّا", "Choose a file"),
  addDrop: p("أفلت الحلقة هنا", "Drop the episode here"),

  /** And the recordings already here, which is the shorter road for a returning show. */
  startTitle: p("أو خذ مقاطع من تسجيل موجود", "Or take clips from one already here"),
  startHint: p(
    "اختر تسجيلًا وتُكتَب لك الجملة في المحرّر. اقرأها قبل أن ترسلها.",
    "Pick one and the sentence is written into the editor for you. Read it before you send it.",
  ),
  badType: p("هذا ليس ملفّ فيديو", "That is not a video file"),
  badTypeDetail: p("MP4 أو MOV أو WebM.", "MP4, MOV or WebM."),
  tooLarge: p("الملفّ أكبر من حدّ خطّتك", "That file is over your plan's limit"),
  tooLargeDetail: f<[string, string]>(
    (size, ceiling) => `هذا الملفّ ${size}، والحدّ ${ceiling}.`,
    (size, ceiling) => `This one is ${size} and the limit is ${ceiling}.`,
  ),
  createFailed: p("تعذّر إنشاء المشروع", "The project could not be created"),
  tryLater: p("جرّب بعد قليل.", "Try again in a moment."),

  /** Each recording keeps its own shelf, because that is what came out of it. */
  fromRecording: f<[number]>(
    (n) => (n === 1 ? "مقطع واحد" : `${n} مقاطع`),
    (n) => (n === 1 ? "1 clip" : `${n} clips`),
  ),
  openRecording: p("افتح التسجيل", "Open the recording"),

  untitled: p("مقطع بلا عنوان", "Untitled clip"),
  save: p("احفظ", "Save"),
  emptyTitle: p("لم يُقصّ شيء بعد", "Nothing cut yet"),
  emptyLeadStart: p("اختر تسجيلًا أعلاه، أو افتح واحدًا واطلب ", "Pick a recording above, or open one and ask for "),
  emptyLeadAction: p("ثلاثة مقاطع", "Three clips"),
  emptyLeadEnd: p(
    " في صفّ اللمسات. كل لحظة تعود منشورًا قائمًا بذاته، بعنوان ممّا قيل فيها.",
    " in the looks row. Each moment comes back as its own post, titled by what is said in it.",
  ),
  capped: f<[number, number]>(
    (shown, total) => `نعرض أحدث ${shown} من ${total}. والبقيّة في التسجيلات التي جاءت منها.`,
    (shown, total) => `Showing the newest ${shown} of ${total}. The rest are in the recordings they came from.`,
  ),
} as const;
