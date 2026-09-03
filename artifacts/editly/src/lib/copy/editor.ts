/**
 * The editor and everything that opens inside it: the panels, the caption
 * faces, the marks on the timeline, and speaking instead of typing.
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
   * The editor, which is the product.
   *
   * Noah's name stays Noah in both languages, like every other product name
   * here. The welcome message is the one piece of copy on this screen written
   * in a voice rather than a register, and the Arabic is written as somebody
   * would actually say it rather than as a translation of the English joke.
   */
export const EDITOR = {
  notFound: p("لم يُعثر على المشروع", "Project not found"),
  export: p("تصدير", "Export"),
  generateEdit: p("نفّذ التعديل", "Generate Edit"),

  uploadTitle: p("ارفع التسجيل الخام", "Upload Raw Footage"),
  uploadHint: p("اسحب وأفلت، أو اضغط للاختيار", "Drag and drop or click to browse"),
  uploadFormats: f<[string]>(
    (ceiling) => `MP4 أو MOV أو WebM • حتى ${ceiling}`,
    (ceiling) => `MP4, MOV or WebM • up to ${ceiling}`,
  ),
  selectVideo: p("اختر فيديو", "Select Video"),
  uploading: p("يُرفع الفيديو…", "Uploading Video..."),
  finishing: p("نُنهي…", "Finishing up..."),
  finishingDetail: p(
    "فيديوك محفوظ. نقرأ طوله ونأخذ لقطة غلاف.",
    "Your video is stored. Reading its length and taking a poster frame.",
  ),
  uploadedOf: f<[string, string]>(
    (done, total) => ` · ${done} من ${total}`,
    (done, total) => ` · ${done} of ${total}`,
  ),
  signInAgain: p("سجّل الدخول من جديد", "Please sign in again"),
  uploaded: p("رُفع الفيديو", "Video uploaded"),
  uploadedDetail: p("فيديوك محفوظ وجاهز للتعديل.", "Your video is stored and ready for editing."),
  uploadFailed: p("فشل الرفع", "Upload failed"),

  aiEdited: p("عُدِّل آليًّا", "AI Edited"),
  play: p("شغّل", "Play"),
  pause: p("أوقف", "Pause"),
  fillScreen: p("املأ الشاشة", "Fill the screen"),
  leaveFullscreen: p("اخرج من ملء الشاشة", "Leave full screen"),
  goToNote: f<[string, string]>(
    (at, said) => `اذهب إلى الملاحظة عند ${at}: ${said}`,
    (at, said) => `Go to the note at ${at}: ${said}`,
  ),

  matchTitle: p("طابِق فيديو آخر", "Match another video"),
  matchAttached: p(
    "سيُعدَّل التنفيذ القادم ليطابق المقطع الذي أرفقته: إيقاعه، وكم يُبقي من الصمت، ومستواه، وألوانه.",
    "Your next render is edited to match the clip you attached: its pace, how much silence it keeps, its level and its colour.",
  ),
  matchLead: f<[string]>(
    (ceiling) =>
      `ارفع مقطعًا قصيرًا بالستايل الذي تريده ونقرأه: كم مرّة يقطع، وكم صمتًا يترك، وكم يعلو، وكيف يُدرَّج لونه. دون ${ceiling}، ولا ننظر إلا في أوّل دقيقتين.`,
    (ceiling) =>
      `Upload a short clip in the style you want and we read it: how often it cuts, how much silence it leaves, how loud and how graded it ends up. Under ${ceiling}, and we only look at the first two minutes.`,
  ),
  chooseReference: p("اختر مقطعًا مرجعيًّا", "Choose a reference clip"),
  uploadingShort: p("يُرفع…", "Uploading…"),
  referenceAttached: p("أُرفق المرجع", "Reference attached"),
  referenceAttachedDetail: p("سيُعدَّل تنفيذك القادم ليطابقه.", "Your next render will be edited to match it."),
  couldNotAttach: p("تعذّر إرفاق هذا المرجع", "Could not attach that reference"),
  couldNotRemoveReference: p("تعذّرت إزالة المرجع", "Could not remove the reference"),

  looksLong: p("لمسات بضغطة", "One-click looks"),
  looksShort: p("اللمسات", "Looks"),
  needsMusic: p("يحتاج ملف موسيقى في هذا المشروع", "Needs a music file in this project"),
  needsMusicSuffix: p("‏. يحتاج ملف موسيقى في هذا المشروع", ". Needs a music file in this project"),
  captionType: p("خط الكابشن", "Caption type"),

  panelLooks: p("اللمسات", "Looks"),
  panelType: p("الخط", "Type"),
  panelClips: p("المقاطع", "Clips"),
  panelFiles: p("الملفات", "Files"),
  panelMatch: p("طابِق", "Match"),
  panelRail: p("لوحات التعديل", "Editing panels"),

  noahRole: p("محرّرك الذكي", "Your AI editor"),
  noahTapWhatIDid: p("اضغط لتقرأ ما فعلته", "Tap to read what I did"),
  noahTapConversation: p("اضغط لتقرأ المحادثة", "Tap to read the conversation"),
  noahSomethingNew: p("عند نوح شيء جديد", "Noah has something new to say"),
  noahWelcome: p(
    "أهلًا، أنا نوح 👋\nمحرّر الفيديو عندك.\n\nارفع فيديوك وقل لي الإحساس الذي تريده، وأحوّله إلى مقطع يُشاهَد.",
    "Hey, I'm Noah 👋\nYour AI video editor.\n\nUpload your video and tell me the vibe, and I'll turn it into a viral clip.",
  ),
  describeYourEdit: p("صف تعديلك…", "Describe your edit..."),
  sendFailed: p("تعذّر إرسال الرسالة", "Failed to send message"),

  renderQueued: p("التنفيذ في الطابور", "Render queued"),
  renderQueuedDetail: p(
    "يمكنك مغادرة هذه الصفحة. سنكمل العمل.",
    "You can leave this page. We'll keep working.",
  ),
  couldNotStartRender: p("تعذّر بدء التنفيذ", "Could not start the render"),
  renderDidNotFinish: p("لم يكتمل هذا التنفيذ.", "That render didn't finish."),
  somethingOnOurSide: p("حدث خطأ عندنا.", "Something went wrong on our side."),
  starting: p("يبدأ…", "Starting…"),
  tryRenderAgain: p("أعد هذا التنفيذ", "Try that render again"),
  wontPreview: p("هذا الملف لا يُعرض هنا", "This file will not preview here"),
  wontPreviewDetail: p(
    "محفوظ بأمان، ويُعدَّل ويُصدَّر كالمعتاد.",
    "It is stored safely, and it still edits and exports normally.",
  ),
  workingOnIt: p("نعمل عليه…", "Working on it…"),
  keepsGoing: f<[number]>(
    (percent) => `${percent}% · يمكنك إغلاق الصفحة، والعمل يستمرّ`,
    (percent) => `${percent}% · you can close this page, it keeps going`,
  ),
} as const;

  /**
   * Marks on the timeline: the one place the person points at a second.
   *
   * `atMoment` is not ordinary copy. It builds the sentence the planner then
   * *parses*, and both halves have to match a pattern `parseMoments` knows:
   * "at 0:12 …" and «عند 0:12 …». Changing either word here without changing
   * the matcher is a mark that is silently dropped, which is the exact failure
   * `momentsNotHonoured` exists to report.
   */
export const MARKS = {
  atMoment: f<[string, string]>(
    (at, said) => `عند ${at} ${said}.`,
    (at, said) => `At ${at} ${said}.`,
  ),
  noteThis: p("سجّل هذه اللحظة", "Note this moment"),
  noted: f<[number]>(
    (count) => (count === 1 ? "لحظة واحدة مسجّلة" : `${count} لحظات مسجّلة`),
    (count) => `${count} ${count === 1 ? "moment" : "moments"} noted`,
  ),
  placeholder: p("ماذا يحدث هنا؟", "what should happen here?"),
  add: p("أضف", "Add"),
  removeAt: f<[string]>(
    (at) => `احذف الملاحظة عند ${at}`,
    (at) => `Remove the note at ${at}`,
  ),
} as const;

  /** Caption faces: the picker, and the ones a person brings themselves. */
export const FONTS = {
  lead: p(
    "الخط الذي تُرسم به الكابشنات. التنفيذ القادم يستعمله، وما نُفّذ من قبل يبقى بخطّه.",
    "What captions are drawn in. The next render uses it; the ones already made keep the face they were made with.",
  ),
  latinHeading: p("الإنجليزية واللاتينية", "English and Latin"),
  arabicHeading: p("العربية", "العربية"),
  addYourOwn: p("أضف خطًّا من عندك", "Add your own font"),
  rights: p(
    "استعمل خطوطًا تملك حق استعمالها. الكابشنات تُحرَق داخل فيديوهات تنشرها أنت وعملاؤك، وأغلب تراخيص الخطوط تعامل هذا معاملةً غير استعمال الخط على جهازك.",
    "Use fonts you have the right to. Captions are burned into videos you and your clients publish, which most font licences treat differently from using a font on your own machine.",
  ),
  signInAgain: p("سجّل الدخول من جديد لإضافة خط.", "Sign in again to add a font."),
  couldNotAdd: p("تعذّرت إضافة هذا الخط.", "That font could not be added."),
  couldNotUpload: p("تعذّر رفع هذا الخط.", "That font could not be uploaded."),
  couldNotRemove: p("تعذّرت إزالة هذا الخط.", "Could not remove that font."),
  removeFace: f<[string]>((label) => `أزل ${label}`, (label) => `Remove ${label}`),
  statusPending: p("بانتظار القياس", "Waiting to be measured"),
  statusPreparing: p("يُقاس، ثوانٍ قليلة", "Measuring it, a few seconds"),
  statusReady: p("جاهز", "Ready"),
  statusRefused: p("لا يصلح للاستعمال", "Cannot be used"),
} as const;

  /**
   * Speaking instead of typing.
   *
   * Two languages are in play here and they are not the same one. The button's
   * own words belong to the *screen* — somebody reading an Arabic product gets
   * an Arabic label. What the label is *about* is the language the microphone
   * is listening for, which is a separate choice with its own control, because
   * the one moment every guess about it is wrong is the moment a person
   * switches language, and that is exactly when they would be told the
   * microphone is broken.
   */
export const VOICE = {
  speak: p("تكلّم بدل الكتابة", "Speak instead of typing"),
  stopListening: p("أوقف الاستماع", "Stop listening"),
  listeningArabic: p("يستمع بالعربية", "Listening in Arabic"),
  listeningEnglish: p("يستمع بالإنجليزية", "Listening in English"),
  switchToEnglish: p("يستمع بالعربية. اضغط للإنجليزية.", "Listening in Arabic. Press to switch to English."),
  switchToArabic: p("يستمع بالإنجليزية. اضغط للعربية.", "Listening in English. Press to switch to Arabic."),
} as const;

  /** The project's own library of files, and the stock sheet under it. */
export const LIBRARY = {
  title: p("ملفات هذا المشروع", "Files in this project"),
  lead: p(
    "لقطات إضافية، صور، شعار. وموسيقى تُوضع تحت التعديل لا فوقه.",
    "B-roll, screenshots, a logo. And music, which goes under the edit rather than on it.",
  ),
  addFiles: p("أضف ملفات", "Add files"),
  adding: f<[number, number]>(
    (done, total) => `يُضاف ${done}/${total}…`,
    (done, total) => `Adding ${done}/${total}…`,
  ),
  empty: f<[string]>(
    (ceiling) =>
      `لا شيء بعد. الملفات التي تضيفها هنا يمكن قصّها كلقطات إضافية، أو وضعها فوق الكادر، أو تشغيلها تحت التعديل كلّه إن كانت موسيقى تملك حقوقها. حتى ${ceiling} للملف.`,
    (ceiling) =>
      `Nothing yet. Files you add here can be cut in as b-roll, laid over the frame, or, if it is a track you have the rights to, played under the whole edit. Up to ${ceiling} each.`,
  ),
  removeFile: f<[string]>((label) => `أزل ${label}`, (label) => `Remove ${label}`),
  thisFile: p("هذا الملف", "this file"),
  notMedia: f<[string]>(
    (name) => `«${name}» ليس فيديو ولا صورة ولا صوتًا.`,
    (name) => `"${name}" is not a video, image or audio file.`,
  ),
  sessionExpired: p("انتهت جلستك. سجّل الدخول من جديد.", "Your session expired. Sign in again."),
  couldNotAdd: f<[string]>(
    (name) => `تعذّرت إضافة «${name}».`,
    (name) => `Could not add "${name}".`,
  ),
} as const;

  /** The stock sheet under the project library. */
export const STOCK = {
  title: p("أو ابحث عن شيء", "Or find something"),
  lead: p(
    "مقاطع وصور مجانية، تُضاف إلى هذا المشروع كأي ملف آخر.",
    "Free stock clips and photos, added to this project like any other file.",
  ),
  placeholder: p("مدينة ليلًا، قهوة، مكتب…", "city at night, coffee, desk…"),
  search: p("ابحث", "Search"),
  closePreview: p("أغلق المعاينة", "Close the preview"),
  add: p("أضفه إلى المشروع", "Add to this project"),
  adding: p("يُضاف…", "Adding…"),
  nothingBack: p(
    "لم يعد شيء بهذه الكلمة. جرّب كلمة أبسط. مكتبات الصور تفهرس الأشياء والأماكن أفضل ممّا تفهرس المشاعر.",
    "Nothing came back for that. Try a plainer word. Stock libraries index objects and places better than they index moods.",
  ),
  notSwitchedOn: p("مكتبة الصور غير مفعّلة بعد.", "The stock library is not switched on yet."),
  searchFailed: p("لم ينجح هذا البحث.", "That search did not work."),
  couldNotFetch: p("تعذّر جلب هذا الملف.", "Could not fetch that file."),
  couldNotAdd: p("تعذّرت إضافته إلى المشروع.", "Could not add that to the project."),
} as const;

  /** The clips a render cut out of one recording, inside the project. */
export const PROJECT_CLIPS = {
  clip: f<[number, string, string]>(
    (n, from, to) => `مقطع ${n} · ${from}–${to}`,
    (n, from, to) => `Clip ${n} · ${from}–${to}`,
  ),
  saveIt: p("افتح هذا المقطع في تبويب جديد لحفظه", "Open this clip in a new tab to save it"),
  openAsProject: p("افتح هذا المقطع مشروعًا مستقلًّا", "Open this clip as its own project"),
  deleteClip: p("احذف هذا المقطع", "Delete this clip"),
  yourClips: f<[number]>((count) => `مقاطعك (${count})`, (count) => `Your clips (${count})`),
  capped: f<[number]>(
    (limit) => `أحدث ${limit} مقطعًا من هذا التسجيل. وما قبلها في صفحة المقاطع.`,
    (limit) => `The newest ${limit} clips from this recording. Anything earlier is on your Clips page.`,
  ),
  earlierSets: f<[number]>((count) => `مجموعات أقدم (${count})`, (count) => `Earlier sets (${count})`),
} as const;
