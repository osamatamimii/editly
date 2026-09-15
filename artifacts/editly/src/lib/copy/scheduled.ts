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
    "اربط الحسابات اللي بتنشر عليها، وبعدين ابعت التعديل الجاهز لأي واحد منها بالوقت اللي بتختاره. وفيك تسحب منشور ما دام ما طلع.",
    "Connect the accounts you post to, then send a finished edit to as many of them as you like at a time you choose. You can call a post back until it leaves.",
  ),
  yourAccounts: p("حساباتك", "Your accounts"),
  whatIsGoingOut: p("شو بالطريق", "What is going out"),
  thatAccount: p("هالحساب", "That account"),
  connected: f<[string]>((who) => `انربط ${who}`, (who) => `${who} connected`),
  connectedDetail: p(
    "فيك تجدول عليه من أي تعديل جاهز.",
    "It can be scheduled to from any finished edit.",
  ),
  notConnected: f<[string]>((who) => `ما انربط ${who}`, (who) => `${who} was not connected`),
  // The platform's own words when it gave any. "redirect_uri mismatch" is
  // something somebody can act on; "could not connect" is not.
  refusedByPlatform: p("المنصّة رفضت الربط.", "The platform refused the connection."),
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
  reading: p("عم نقرا شو مجدول…", "Reading what is scheduled…"),
  empty: p(
    "ما في شي مجدول. من تصدير جاهز بتقدر تبعت تعديل لكذا حساب بوقت بتختاره.",
    "Nothing scheduled. From a finished export you can send an edit to several accounts at a time you choose.",
  ),
  noCaption: p("بلا كابشن", "No caption"),
  seeIt: p("افتحه", "See it"),
  callBack: p("اسحب هالمنشور", "Call this post back"),
  calledBack: p("انسحب", "Called back"),
  calledBackDetail: p("ما رح يطلع.", "It will not go out."),
  stillScheduled: p("لسا مجدول", "Still scheduled"),
  couldNotCallBack: p("ما قدرنا نسحبه.", "That could not be called back."),
  tryAgain: p("جرّب مرّة تانية.", "Please try again."),
  capped: f<[number, number]>(
    (shown, total) => `عم نعرض ${shown} من ${total}. كل اللي ما طلع لسا هون، والأقدم أبعد بالقائمة.`,
    (shown, total) => `Showing ${shown} of ${total}. Everything still to go out is here; older posts are further back.`,
  ),

  endingScheduled: p("عم يطلع", "Going out"),
  endingPublishing: p("عم ينبعت", "Sending"),
  endingPublished: p("اننشر", "Posted"),
  endingFailed: p("ما طلع", "Did not go"),
  // Not a failure. Nothing went wrong; it was simply too late to be worth
  // sending, and what it needs is a new time rather than a fix.
  endingMissed: p("ما انبعت، فات وقته", "Not sent, too late"),
  endingCancelled: p("انسحب", "Called back"),

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
    (names) => `${names} بتراجع كل تطبيق قبل ما تسمح له ينشر بدالك. التعديل والجدولة جاهزين، وهالمراجعة هي اللي عم نستناها منهم.`,
    (names, count) =>
      `${names} ${count === 1 ? "reviews" : "review"} every app before letting one post on your behalf. The editing and the scheduling are built; that review is the part waiting on them.`,
  ),
  noCredentials: f<[string]>(
    (names) => `هالنشرة ما عندها بيانات اعتماد ${names} لسا.`,
    (names) => `This deployment does not have ${names} credentials yet.`,
  ),
  or: p(" أو ", " or "),
  characters: f<[string]>((limit) => `${limit} حرفًا`, (limit) => `${limit} characters`),
  verticalOnly: p("‏ · عمودي فقط", " · vertical only"),
  connect: p("اربط", "Connect"),
  addAnother: p("ضيف حساب تاني", "Add another"),
  countConnected: f<[number]>(
    (count) => (count === 1 ? "حساب واحد مربوط" : `${count} حسابات مربوطة`),
    (count) => `${count} connected`,
  ),
  waitingReview: p("بانتظار المراجعة", "Waiting on review"),
  notSetUp: p("مش مجهّزة لسا", "Not set up yet"),
  needsReconnecting: p("بدّه إعادة ربط.", "Needs reconnecting."),
  postsTo: f<[string]>((page) => `بينشر على ${page}`, (page) => `Posts to ${page}`),
  disconnect: f<[string]>((handle) => `افصل ${handle}`, (handle) => `Disconnect ${handle}`),
  disconnected: f<[string]>((handle) => `انفصل ${handle}`, (handle) => `${handle} disconnected`),
  // The number matters. Somebody who set up a week of posts and then
  // disconnected an account has lost that week, and finding out from a post
  // that never appeared is finding out too late.
  cancelledWithIt: f<[number]>(
    (count) => (count === 1 ? "انلغى معه منشور مجدول واحد." : `انلغت معه ${count} منشورات مجدولة.`),
    (count) => `${count} scheduled ${count === 1 ? "post was" : "posts were"} cancelled with it.`,
  ),
  nothingScheduledToIt: p("ما كان مجدول عليه شي.", "Nothing was scheduled to it."),
  couldNotDisconnect: p("ما قدرنا نفصله", "Could not disconnect"),
  couldNotDisconnectDetail: p("ما قدرنا نفصل هالحساب.", "Could not disconnect that account."),
  couldNotConnect: f<[string]>((label) => `ما قدرنا نربط ${label}`, (label) => `Could not connect ${label}`),
  couldNotStartConnect: f<[string]>(
    (label) => `ما قدرنا نبدا ربط ${label}.`,
    (label) => `Could not start connecting ${label}.`,
  ),
  tryAgain: p("جرّب مرّة تانية.", "Please try again."),

  whichPage: f<[number]>(
    (count) => `هالحساب بيدير ${count} صفحات. لأي وحدة بدك تروح المنشورات؟`,
    (count) => `This account manages ${count} Pages. Which one do posts go to?`,
  ),
  postingTo: f<[string]>((page) => `النشر على ${page}`, (page) => `Posting to ${page}`),
  postingToDetail: p("المنشورات المجدولة رح تروح لهالصفحة.", "Scheduled posts will go to this Page."),
  couldNotSetPage: p("ما قدرنا نعيّن الصفحة", "Could not set the Page"),
  couldNotSaveChoice: p("ما قدرنا نحفظ هالاختيار.", "Could not save that choice."),
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
    "أول ما تربط حساب، بيقدر هالتعديل يطلع بموعد بتختاره بالكابشن المكتوب هون، لكذا حساب دفعة وحدة. ",
    "Once an account is connected, this edit can go out on a schedule with the caption written here, to several accounts at once. ",
  ),
  someWaiting: f<[number]>(
    (count) => `${count} من المنصّات بتراجع كل تطبيق قبل ما ينسمح له ينشر بدالك، وهاي الخطوة اللي عم نستناها منهم.`,
    (count) => `${count} of the platforms review every app before it may post on your behalf, which is the part that is waiting on them.`,
  ),
  nonePlatforms: p("ما في منصّة مفعّلة بهالنشرة لسا.", "No platform is switched on for this deployment yet."),
  seeConnections: p("اعرض الحسابات المربوطة", "See connections"),

  captionPlaceholder: p("عن شو هالمقطع؟", "What is this clip about?"),
  hashtagsPlaceholder: p("#وسوم", "#hashtags"),
  shorterFor: f<[string, string]>(
    (label, limit) => `${label} بيقبل ${limit} حرف. اكتب له كابشن أقصر:`,
    (label, limit) => `${label} takes ${limit} characters. Write a shorter one for it:`,
  ),

  inAnHour: p("بعد ساعة", "In an hour"),
  tonight: p("الليلة، 7م", "Tonight, 7pm"),
  tomorrowEvening: p("بكرا، 7م", "Tomorrow, 7pm"),
  tomorrowMorning: p("بكرا، 9ص", "Tomorrow, 9am"),

  pickWhere: p("اختار لوين بدّه يروح", "Pick where it goes"),
  thingsToFix: f<[number]>(
    (count) => (count === 1 ? "شي واحد بدّه تصليح أوّل" : `${count} أشياء بدّها تصليح أوّل`),
    (count) => `${count} thing${count === 1 ? "" : "s"} to fix first`,
  ),
  scheduleTo: f<[number]>(
    (count) => (count === 1 ? "جدول لحساب واحد" : `جدول لـ${count} حسابات`),
    (count) => `Schedule to ${count} ${count === 1 ? "account" : "accounts"}`,
  ),
  scheduledTo: f<[number]>(
    (count) => (count === 1 ? "انجدول لحساب واحد" : `انجدول لـ${count} حسابات`),
    (count) => `Scheduled to ${count} ${count === 1 ? "account" : "accounts"}`,
  ),
  goingOut: f<[string]>((when) => `بيطلع ${when}.`, (when) => `Going out ${when}.`),
  scheduled: p("انجدول", "Scheduled"),
  scheduledDetail: f<[string]>(
    (when) => `بيطلع ${when}. وفيك تسحبه من المشروع ما دام ما طلع.`,
    (when) => `Going out ${when}. You can call it back from the project until it goes.`,
  ),
  notScheduled: p("ما انجدول", "Not scheduled"),
  couldNotSchedule: p("ما قدرنا نجدوله.", "That could not be scheduled."),
  tryAgain: p("جرّب مرّة تانية.", "Please try again."),
} as const;
