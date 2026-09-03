/**
 * Scheduling: the door, the queue, the connections and the composer.
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

  /** The scheduling door: connections and the queue on one page. */
export const SCHEDULED = {
  title: p("المجدولة", "Scheduled"),
  lead: p(
    "اربط الحسابات التي تنشر عليها، ثم أرسل التعديل الجاهز إلى ما شئت منها في الوقت الذي تختاره. ويمكنك سحب منشور ما دام لم يخرج.",
    "Connect the accounts you post to, then send a finished edit to as many of them as you like at a time you choose. You can call a post back until it leaves.",
  ),
  yourAccounts: p("حساباتك", "Your accounts"),
  whatIsGoingOut: p("ما هو في الطريق", "What is going out"),
  thatAccount: p("هذا الحساب", "That account"),
  connected: f<[string]>((who) => `تمّ ربط ${who}`, (who) => `${who} connected`),
  connectedDetail: p(
    "يمكن الجدولة إليه من أي تعديل جاهز.",
    "It can be scheduled to from any finished edit.",
  ),
  notConnected: f<[string]>((who) => `لم يُربط ${who}`, (who) => `${who} was not connected`),
  // The platform's own words when it gave any. "redirect_uri mismatch" is
  // something somebody can act on; "could not connect" is not.
  refusedByPlatform: p("رفضت المنصّة الربط.", "The platform refused the connection."),
} as const;

  /**
   * The queue of posts, and the way to stop one.
   *
   * The five endings are the point of this list, and they are five different
   * things to a person reading: one went out, one was called back on purpose,
   * one needs a token fixed, and one simply came due while the publisher was
   * down. The Arabic keeps them apart the same way the English does.
   */
export const POSTS = {
  reading: p("نقرأ ما هو مجدول…", "Reading what is scheduled…"),
  empty: p(
    "لا شيء مجدول. من تصدير جاهز تستطيع إرسال تعديل إلى عدّة حسابات في وقت تختاره.",
    "Nothing scheduled. From a finished export you can send an edit to several accounts at a time you choose.",
  ),
  noCaption: p("بلا كابشن", "No caption"),
  seeIt: p("افتحه", "See it"),
  callBack: p("اسحب هذا المنشور", "Call this post back"),
  calledBack: p("سُحب", "Called back"),
  calledBackDetail: p("لن يخرج.", "It will not go out."),
  stillScheduled: p("ما زال مجدولًا", "Still scheduled"),
  couldNotCallBack: p("تعذّر سحبه.", "That could not be called back."),
  tryAgain: p("حاول مرّة أخرى.", "Please try again."),
  capped: f<[number, number]>(
    (shown, total) => `نعرض ${shown} من ${total}. كل ما لم يخرج بعد هنا، والأقدم أبعد في القائمة.`,
    (shown, total) => `Showing ${shown} of ${total}. Everything still to go out is here; older posts are further back.`,
  ),

  endingScheduled: p("يخرج", "Going out"),
  endingPublishing: p("يُرسَل", "Sending"),
  endingPublished: p("نُشر", "Posted"),
  endingFailed: p("لم يخرج", "Did not go"),
  // Not a failure. Nothing went wrong; it was simply too late to be worth
  // sending, and what it needs is a new time rather than a fix.
  endingMissed: p("لم يُرسَل، فات وقته", "Not sent, too late"),
  endingCancelled: p("سُحب", "Called back"),

  today: f<[string]>((clock) => `اليوم، ${clock}`, (clock) => `today, ${clock}`),
} as const;

  /**
   * The places an edit can go.
   *
   * Two of these sentences have a plural in them, and Arabic does not make
   * plurals the way English does, so each is written as its own sentence
   * rather than as a string with an "s" appended. That is the whole reason
   * these are templates.
   */
export const CONNECTIONS = {
  reviews: f<[string, number]>(
    (names) => `${names} تراجع كل تطبيق قبل أن تسمح له بالنشر نيابةً عنك. التعديل والجدولة جاهزان، وهذه المراجعة هي ما ننتظره منهم.`,
    (names, count) =>
      `${names} ${count === 1 ? "reviews" : "review"} every app before letting one post on your behalf. The editing and the scheduling are built; that review is the part waiting on them.`,
  ),
  noCredentials: f<[string]>(
    (names) => `لا تملك هذه النشرة بيانات اعتماد ${names} بعد.`,
    (names) => `This deployment does not have ${names} credentials yet.`,
  ),
  or: p(" أو ", " or "),
  characters: f<[string]>((limit) => `${limit} حرفًا`, (limit) => `${limit} characters`),
  verticalOnly: p("‏ · عمودي فقط", " · vertical only"),
  connect: p("اربط", "Connect"),
  addAnother: p("أضف حسابًا آخر", "Add another"),
  countConnected: f<[number]>(
    (count) => (count === 1 ? "حساب واحد مربوط" : `${count} حسابات مربوطة`),
    (count) => `${count} connected`,
  ),
  waitingReview: p("بانتظار المراجعة", "Waiting on review"),
  notSetUp: p("غير مهيّأة بعد", "Not set up yet"),
  needsReconnecting: p("يحتاج إعادة ربط.", "Needs reconnecting."),
  postsTo: f<[string]>((page) => `ينشر على ${page}`, (page) => `Posts to ${page}`),
  disconnect: f<[string]>((handle) => `افصل ${handle}`, (handle) => `Disconnect ${handle}`),
  disconnected: f<[string]>((handle) => `فُصل ${handle}`, (handle) => `${handle} disconnected`),
  // The number matters. Somebody who set up a week of posts and then
  // disconnected an account has lost that week, and finding out from a post
  // that never appeared is finding out too late.
  cancelledWithIt: f<[number]>(
    (count) => (count === 1 ? "أُلغي معه منشور مجدول واحد." : `أُلغيت معه ${count} منشورات مجدولة.`),
    (count) => `${count} scheduled ${count === 1 ? "post was" : "posts were"} cancelled with it.`,
  ),
  nothingScheduledToIt: p("لم يكن مجدولًا إليه شيء.", "Nothing was scheduled to it."),
  couldNotDisconnect: p("تعذّر الفصل", "Could not disconnect"),
  couldNotDisconnectDetail: p("تعذّر فصل هذا الحساب.", "Could not disconnect that account."),
  couldNotConnect: f<[string]>((label) => `تعذّر ربط ${label}`, (label) => `Could not connect ${label}`),
  couldNotStartConnect: f<[string]>(
    (label) => `تعذّر بدء ربط ${label}.`,
    (label) => `Could not start connecting ${label}.`,
  ),
  tryAgain: p("حاول مرّة أخرى.", "Please try again."),

  whichPage: f<[number]>(
    (count) => `هذا الحساب يدير ${count} صفحات. إلى أيّها تذهب المنشورات؟`,
    (count) => `This account manages ${count} Pages. Which one do posts go to?`,
  ),
  postingTo: f<[string]>((page) => `النشر على ${page}`, (page) => `Posting to ${page}`),
  postingToDetail: p("ستذهب المنشورات المجدولة إلى هذه الصفحة.", "Scheduled posts will go to this Page."),
  couldNotSetPage: p("تعذّر تعيين الصفحة", "Could not set the Page"),
  couldNotSaveChoice: p("تعذّر حفظ هذا الاختيار.", "Could not save that choice."),
} as const;

  /**
   * The composer: where an edit goes, what it says, and when.
   *
   * The counts here are the same function the API refuses on, so nothing in
   * this group is a number written twice. What is written twice is the way a
   * count is said, because Arabic and English do not pluralise alike, and
   * "1 accounts" is the sort of thing a person reads as carelessness.
   */
export const COMPOSER = {
  title: p("انشره عنك", "Post it for you"),
  noAccountsLead: p(
    "بمجرّد ربط حساب، يمكن أن يخرج هذا التعديل في موعد تختاره بالكابشن المكتوب هنا، إلى عدّة حسابات دفعة واحدة. ",
    "Once an account is connected, this edit can go out on a schedule with the caption written here, to several accounts at once. ",
  ),
  someWaiting: f<[number]>(
    (count) => `${count} من المنصّات تراجع كل تطبيق قبل أن يُسمح له بالنشر نيابةً عنك، وهذه هي الخطوة التي ننتظرها منهم.`,
    (count) => `${count} of the platforms review every app before it may post on your behalf, which is the part that is waiting on them.`,
  ),
  nonePlatforms: p("لا منصّة مفعّلة في هذه النشرة بعد.", "No platform is switched on for this deployment yet."),
  seeConnections: p("اعرض الحسابات المربوطة", "See connections"),

  captionPlaceholder: p("عمّ يتحدّث هذا المقطع؟", "What is this clip about?"),
  hashtagsPlaceholder: p("#وسوم", "#hashtags"),
  shorterFor: f<[string, string]>(
    (label, limit) => `${label} يقبل ${limit} حرفًا. اكتب له كابشنًا أقصر:`,
    (label, limit) => `${label} takes ${limit} characters. Write a shorter one for it:`,
  ),

  inAnHour: p("بعد ساعة", "In an hour"),
  tonight: p("الليلة، 7م", "Tonight, 7pm"),
  tomorrowEvening: p("غدًا، 7م", "Tomorrow, 7pm"),
  tomorrowMorning: p("غدًا، 9ص", "Tomorrow, 9am"),

  pickWhere: p("اختر إلى أين يذهب", "Pick where it goes"),
  thingsToFix: f<[number]>(
    (count) => (count === 1 ? "أمر واحد يُصلَح أوّلًا" : `${count} أمور تُصلَح أوّلًا`),
    (count) => `${count} thing${count === 1 ? "" : "s"} to fix first`,
  ),
  scheduleTo: f<[number]>(
    (count) => (count === 1 ? "جدوِل إلى حساب واحد" : `جدوِل إلى ${count} حسابات`),
    (count) => `Schedule to ${count} ${count === 1 ? "account" : "accounts"}`,
  ),
  scheduledTo: f<[number]>(
    (count) => (count === 1 ? "جُدوِل إلى حساب واحد" : `جُدوِل إلى ${count} حسابات`),
    (count) => `Scheduled to ${count} ${count === 1 ? "account" : "accounts"}`,
  ),
  goingOut: f<[string]>((when) => `يخرج ${when}.`, (when) => `Going out ${when}.`),
  scheduled: p("جُدوِل", "Scheduled"),
  scheduledDetail: f<[string]>(
    (when) => `يخرج ${when}. ويمكنك سحبه من المشروع ما دام لم يخرج.`,
    (when) => `Going out ${when}. You can call it back from the project until it goes.`,
  ),
  notScheduled: p("لم يُجدوَل", "Not scheduled"),
  couldNotSchedule: p("تعذّرت جدولته.", "That could not be scheduled."),
  tryAgain: p("حاول مرّة أخرى.", "Please try again."),
} as const;
