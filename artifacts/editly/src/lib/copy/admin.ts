/**
 * The operations console.
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
   * The operations console.
   *
   * Translated because somebody reads it at two in the morning, and the person
   * who reads it reads Arabic. What is *not* translated is the data: a job
   * state, a webhook type, an action name, a plan name and a Postgres error
   * stay in the words the systems that produce them use. Turning `stalled` into
   * Arabic on this screen and leaving it English in the log is how a person
   * searching for the thing they just read finds nothing.
   */
export const ADMIN = {
  title: p("التشغيل", "Operations"),
  lead: p(
    "للقراءة بس. كل رقم هون جاي من نفس الوحدات اللي بيفوتر فيها المنتج وبيجدول.",
    "Read-only. Every number here comes from the same modules the product bills and schedules with.",
  ),
  didNotWork: p("ما نجح هيك.", "That did not work."),
  loading: p("عم يحمّل…", "Loading…"),
  never: p("أبدًا", "never"),
  yes: p("نعم", "yes"),
  no: p("لا", "no"),
  all: p("الكل", "all"),

  reasonLabel: p(
    "السبب (مطلوب قبل تنفيذ أي شيء أدناه)",
    "Reason (required before anything below can be done)",
  ),
  reasonPlaceholder: p(
    "ليش عم تعمل هيك؟ بينكتب بالسجلّ باسمك.",
    "Why are you doing this? It goes in the log with your name.",
  ),
  typeReasonFirst: p("اكتب سبب أوّل", "Type a reason first"),

  usageTitle: p("التخزين، وكم يكلّف نقله", "Storage, and what moving it costs"),
  thisMonth: p("هالشهر", "this month"),
  stored: p("المخزَّن", "Stored"),
  notKnown: p("غير معروف", "not known"),
  storageSilent: p("التخزين ما ردّ", "storage did not answer"),
  objects: f<[number]>((count) => `${count} كائنًا`, (count) => `${count} objects`),
  pulledByRenders: p("سحبته التنفيذات", "Pulled by renders"),
  countedRenders: f<[number]>((count) => `${count} تنفيذًا`, (count) => `${count} renders`),
  countedAndBefore: f<[number, number]>(
    (counted, before) => `${counted} محسوبة، و${before} قبل بدء العدّ`,
    (counted, before) => `${counted} counted, ${before} before counting began`,
  ),
  egressCost: p("كلفة هذا الإخراج", "That egress costs"),
  egressOnR2: p("على R2 هي $0 مهما بلغ الحجم", "on R2 it is $0, at any volume"),
  nothingYet: p("لا شيء بعد", "nothing yet"),
  unmeasured: p(
    "التنفيذات اللي قبل القياس مش بالمجموع، فالرقم الحقيقي أعلى.",
    "Renders from before this was measured are not in the total, so the real figure is higher.",
  ),

  deploymentTitle: p("هذه النشرة مقابل الشيفرة", "This deployment against the code"),
  deploymentSummary: f<[number, number, number]>(
    (wrong, unknown, ok) => `${wrong} خطأ · ${unknown} مجهول · ${ok} سليم`,
    (wrong, unknown, ok) => `${wrong} wrong · ${unknown} unknown · ${ok} fine`,
  ),
  expects: p("يتوقّع", "expects"),
  actually: p("فعليًّا", "actually"),

  renderingNow: p("عم يتنفّذ", "Rendering now"),
  waitingInQueue: p("في الطابور", "Waiting in queue"),
  behindLiveMachine: p("ورا جهاز شغّال", "behind a live machine"),
  unattended: p("بلا جهاز", "Unattended"),
  unattendedHint: p("بالطابور وما في حدا يسمع", "queued with nothing listening"),
  failedDay: p("فشلت (24 ساعة)", "Failed (24h)"),
  worker: p("الجهاز", "Worker"),
  workerUnclear: p("غير واضح", "unclear"),
  workerOnline: p("شغّال", "online"),
  workerOffline: p("واقف", "offline"),
  workerContradiction: f<[string]>(
    (ago) => `الخادم بيقول إنه شغّال، وآخر نبضة قبل ${ago}. ما بيصحّوا التنين.`,
    (ago) => `the server says online, but the last beat was ${ago} ago. Both cannot be true.`,
  ),
  neverSeen: p("ما انشاف أبدًا", "never seen"),
  lastBeat: f<[string]>((ago) => `آخر نبضة قبل ${ago}`, (ago) => `last beat ${ago} ago`),
  doneDay: p("اكتملت (24 ساعة)", "Done (24h)"),
  minutesThisMonth: p("الدقائق هذا الشهر", "Minutes this month"),
  accounts: p("الحسابات", "Accounts"),
  newThisWeek: f<[number]>(
    (count) => `${count} جديدة هالأسبوع`,
    (count) => `${count} new this week`,
  ),

  postingTitle: p("النشر", "Posting"),
  overdue: p("فات وقتها", "Overdue"),
  overdueHint: p("فات وقتها وما التقطها حدا", "past their time, unclaimed"),
  midSend: p("في منتصف الإرسال", "Mid-send"),
  midSendHint: p("الناشر بطّل يحملها", "a publisher stopped holding these"),
  dueWithinHour: p("بيحين خلال ساعة", "Due within the hour"),
  postedDay: p("اننشرت (24 ساعة)", "Posted (24h)"),
  tooLateToSend: f<[number]>(
    (count) => `${count} فات وقت إرسالها`,
    (count) => `${count} too late to send`,
  ),

  subscriptions: p("الاشتراكات", "Subscriptions"),
  monthlyRecurring: f<[number]>((usd) => `$${usd} / شهريًا`, (usd) => `$${usd} / month`),
  paymentsTitle: p("المدفوعات", "Payments"),
  lastBillingEvents: p("آخر أحداث الفوترة", "Last billing events"),
  headType: p("النوع", "Type"),
  headEmail: p("البريد", "Email"),
  headPlan: p("الخطّة", "Plan"),
  headReceived: p("وصل", "Received"),
  headApplied: p("انطبّق", "Applied"),
  headOutcome: p("النتيجة", "Outcome"),
  nothingFromFreemius: p("ما في شي من Freemius لسا.", "Nothing from Freemius yet."),

  searchByEmail: p("دوّر بالبريد", "Search by email"),
  headMinutes: p("الدقائق", "Minutes"),
  headProjects: p("المشاريع", "Projects"),
  headJoined: p("انضمّ", "Joined"),
  headLastSeen: p("آخر ظهور", "Last seen"),
  grantMinutes: p("‏+30 دقيقة", "+30 min"),
  suspend: p("علِّق", "Suspend"),
  nobodyYet: p("ما في حدا لسا.", "Nobody yet."),
  /*
    Setting a plan by hand, which the server has been able to do since the
    console was built and no screen ever asked it to.

    It is a select rather than a button because the action is "make it this",
    not "make it more": the case it exists for is a webhook that failed and a
    customer holding the wrong thing, and that can point in either direction.
  */
  setPlan: p("عيّن الخطّة", "Set plan"),
  planGivenUntil: f<[string]>((until) => `ممنوحة لحدّ ${until}`, (until) => `given, until ${until}`),

  codesTitle: p("أكواد الخطط", "Plan codes"),
  codesLead: p(
    "الكود بيفتح خطّة لمدّة، بلا دفع. ما بيخصم من سعر ولا بيمرّ على بطاقة: الخصم الجزئي بيصير عند جهة الدفع مش هون.",
    "A code opens a plan for a while, with no payment. It does not reduce a price and never touches a card: a partial discount belongs at the checkout, not here.",
  ),
  mintCode: p("اعمل كود", "Mint a code"),
  codeWord: p("كلمة الكود (اختياري)", "The word (optional)"),
  codeMonths: p("شهور", "Months"),
  codeSeats: p("عدد الحسابات", "Accounts"),
  codeMinted: f<[string]>((code) => `انعمل الكود ${code}`, (code) => `Minted ${code}`),
  headCode: p("الكود", "Code"),
  headGives: p("بيعطي", "Gives"),
  headUsed: p("انستعمل", "Used"),
  headNote: p("لمن", "For"),
  revokeCode: p("اسحب", "Withdraw"),
  codeRevoked: p("مسحوب", "Withdrawn"),
  codeUsedUp: p("خلصان", "Used up"),
  noCodes: p("ما في أكواد لسا.", "No codes yet."),
  codeMonthsShort: f<[number]>((months) => `${months} شهرًا`, (months) => `${months} mo`),
  codeSeatsShort: f<[number, number]>(
    (used, of) => `${used} من ${of}`,
    (used, of) => `${used} of ${of}`,
  ),

  waitlistTitle: p("قائمة الانتظار", "Waiting list"),
  waiting: f<[number]>((count) => `${count} في الانتظار`, (count) => `${count} waiting`),
  headFrom: p("من", "From"),
  nobodyAsked: p("ما طلب حدا لسا.", "Nobody has asked yet."),

  recentRenders: p("أحدث التنفيذات", "Recent renders"),
  headStatus: p("الحالة", "Status"),
  headProject: p("المشروع", "Project"),
  headBilled: p("المفوتَر", "Billed"),
  headCreated: p("انعمل", "Created"),
  headFinished: p("انتهى", "Finished"),
  headWhatTheyWereTold: p("شو انقال لهم، وشو صار", "What they were told, and what happened"),
  headWhatItDid: p("شو عمل", "What it did"),
  requeue: p("رجّعه للطابور", "Requeue"),
  noRendersYet: p("ما في تنفيذات لسا.", "No renders yet."),
  unattendedSuffix: f<[string]>(
    (status) => `${status} · بلا جهاز`,
    (status) => `${status} · unattended`,
  ),

  logTitle: p("شو انعمل هون", "What has been done here"),
  logLead: p("كل فعل فوق بيكتب سطر. وما في شي بيشيل سطر.", "Every action above writes a row. Nothing removes one."),
  headWhen: p("متى", "When"),
  headAction: p("الفعل", "Action"),
  headSubject: p("المعنيّ", "Subject"),
  headReason: p("السبب", "Reason"),
  headDetail: p("التفصيل", "Detail"),
  nothingDoneYet: p("ما انعمل شي هون لسا.", "Nothing has been done here yet."),

  nothingNeedsYou: p("ما في شي بدّه ياك.", "Nothing needs you."),
  allClear: p(
    "في جهاز عم يسمع، والطابور عم يتحرّك، وكل دفعة وصلت انطبّقت.",
    "A machine is listening, the queue is moving, and every payment that arrived has been applied.",
  ),
  thingsNeedYou: f<[number]>(
    (count) => (count === 1 ? "شي واحد بدّه ياك" : `${count} أشياء بدّها ياك`),
    (count) => (count === 1 ? "One thing needs you" : `${count} things need you`),
  ),
  workerContradicts: p(
    "الجهاز بيقول إنه شغّال ونبضته قديمة. ما بيصحّوا التنين.",
    "The worker reports online with a stale heartbeat. Both cannot be true.",
  ),
  nobodyListening: p(
    "ما في جهاز عم يسمع. ما رح يتنفّذ شي لحتى يرجع واحد.",
    "No machine is listening. Nothing will render until one comes back.",
  ),
  unattendedProblem: f<[number]>(
    (count) =>
      count === 1
        ? "تنفيذ واحد بالطابور وما في شي بيلتقطه."
        : `${count} تنفيذات بالطابور وما في شي بيلتقطها.`,
    (count) =>
      `${count} ${count === 1 ? "render is" : "renders are"} queued with nothing to pick ${count === 1 ? "it" : "them"} up.`,
  ),
  failedProblem: f<[number]>(
    (count) =>
      count === 1
        ? "تنفيذ واحد فشل باليوم الأخير. والسبب على سطره تحت."
        : `${count} تنفيذات فشلت باليوم الأخير. والسبب على كل سطر تحت.`,
    (count) =>
      `${count} ${count === 1 ? "render" : "renders"} failed in the last day. The reason is on each row below.`,
  ),
  overdueProblem: f<[number]>(
    (count) =>
      count === 1
        ? "منشور مجدول واحد فات وقته وما التقطه حدا. الناشر ما بيكنس، وما رح ينخبّر حدا."
        : `${count} منشورات مجدولة فات وقتها وما التقطها حدا. الناشر ما بيكنس، وما رح ينخبّر حدا.`,
    (count) =>
      `${count} scheduled ${count === 1 ? "post is" : "posts are"} past their time and unclaimed. The publisher is not sweeping, and nobody will be told.`,
  ),
  strandedProblem: f<[number]>(
    (count) =>
      count === 1
        ? "منشور واحد كان بنصّ الإرسال لمّا وقف ناشر. وما منعرف إذا طلع."
        : `${count} منشورات كانت بنصّ الإرسال لمّا وقف ناشر. وما منعرف إذا طلعت.`,
    (count) =>
      `${count} ${count === 1 ? "post was" : "posts were"} mid-send when a publisher stopped. It is not known whether ${count === 1 ? "it" : "they"} went out.`,
  ),
  reconnectProblem: f<[number]>(
    (count) =>
      count === 1
        ? "حساب مربوط واحد بيحمل مفتاح ما عادت المنصّة تقبله. وكل منشور مجدول عليه رح يفشل بموعده."
        : `${count} حسابات مربوطة بتحمل مفاتيح ما عادت المنصّة تقبلها. وكل منشور مجدول عليها رح يفشل بموعده.`,
    (count) =>
      `${count} connected ${count === 1 ? "account has" : "accounts have"} a token the platform no longer accepts. Every post scheduled to ${count === 1 ? "it" : "them"} will fail as it comes due.`,
  ),
  billingProblem: f<[number]>(
    (count) =>
      count === 1
        ? "حدث فوترة واحد وصل وما انطبّق. في حدا دفع مقابل شي ما بيملكه."
        : `${count} أحداث فوترة وصلت وما انطبّقت. في حدا دفع مقابل شي ما بيملكه.`,
    (count) =>
      `${count} billing ${count === 1 ? "event" : "events"} arrived and did not apply. Somebody has paid for something they do not have.`,
  ),

  /*
    The rail down the left, and the eight screens it leads to.

    Short on purpose. A navigation label is read a hundred times and clicked
    once, and the sentence that explains a screen belongs on the screen rather
    than in the word that opens it.
  */
  navOverview: p("نظرة عامة", "Overview"),
  navPlatform: p("المنصّة", "The platform"),
  navInsights: p("الخلاصة", "Insights"),
  navAttention: p("بدّه ياك", "Needs you"),
  navAccounts: p("الحسابات", "Accounts"),
  navRenders: p("التنفيذات", "Renders"),
  navPosting: p("النشر", "Posting"),
  navMoney: p("المال", "Money"),
  navSystem: p("النظام", "System"),
  navLog: p("السجلّ", "Log"),
  navBack: p("رجوع للمنتج", "Back to the product"),

  /*
    The work queue.

    The console could say that three renders had failed; it could not say
    which. Every other screen here answers "how many" and this one answers
    "what", so its words are the words of a list of jobs to do rather than of a
    report.
  */
  queueTitle: p("شو بدّه حدا", "What needs somebody"),
  queueLead: p(
    "كل سطر شي بعينه مش عدد. الأسوأ أوّل، والأقدم قبل الأحدث جوّا النوع الواحد.",
    "Every row is one thing, not a number. Worst first, and oldest before newest within a kind.",
  ),
  queueClear: p("ما في شي بالطابور.", "Nothing in the queue."),
  queueClearLead: p(
    "ما في عامل غايب، ولا تنفيذ متروك، ولا منشور فات وقته، ولا دفعة وصلت وما انطبّقت.",
    "No missing worker, no unclaimed render, no post past its time, no payment that arrived and did not apply.",
  ),
  queueShowing: f<[number, number]>(
    (shown, total) => `عم نعرض ${shown} من ${total}`,
    (shown, total) => `showing ${shown} of ${total}`,
  ),
  headWhat: p("شو هو", "What"),
  headSince: p("منذ", "Since"),
  headWhose: p("لِمن", "Whose"),
  ago: f<[string]>((duration) => `منذ ${duration}`, (duration) => `${duration} ago`),

  /*
    One label per kind, and the vocabulary is closed.

    Written here beside each other rather than each beside its query, because
    these are read as a column: nine badges stacked down one screen, and a
    reader tells them apart by their shape more than by their words. Two that
    sounded alike when they were written apart — "failed" and "unclaimed" — are
    the two that matter most to tell apart, so they are named for what is true
    of the row rather than for how bad it is.
  */
  kindWorkerGone: p("ما في عامل", "No worker"),
  kindRenderUnattended: p("تنفيذ متروك", "Render unclaimed"),
  kindPostOverdue: p("منشور فات وقته", "Post overdue"),
  kindPostStranded: p("منشور في منتصف الإرسال", "Post mid-send"),
  kindBillingUnapplied: p("دفعة ما انطبّقت", "Payment not applied"),
  kindRenderFailed: p("تنفيذ فشل", "Render failed"),
  kindAccountDisconnected: p("حساب مقطوع", "Account disconnected"),
  kindMinutesSpent: p("خلصت الدقايق", "Minutes spent"),
  kindMinutesNearlySpent: p("الدقايق عم تخلص", "Minutes nearly spent"),

  minutesOf: f<[number, number]>(
    (used, included) => `${used} من ${included} دقيقة`,
    (used, included) => `${used} of ${included} minutes`,
  ),
  neverBeat: p("ما انسمع منه أبدًا", "never heard from"),

  /* The first screen: the platform in one page, money first. */
  platformToday: p("المنصّة اليوم", "The platform today"),
  paying: f<[number, number]>(
    (paid, total) => `${paid} حساب بيدفع من ${total}`,
    (paid, total) => `${paid} paying of ${total}`,
  ),
  capLine: f<[number, number]>(
    (over, near) =>
      `${over === 1 ? "حساب واحد خلصت دقايقه" : `${over} حسابات خلصت دقايقها`} هالشهر، و${near === 1 ? "واحد قرّب على حدّه" : `${near} قرّبوا على حدّهم`}`,
    (over, near) =>
      `${over} ${over === 1 ? "account has" : "accounts have"} spent their minutes this month, and ${near} ${near === 1 ? "is" : "are"} close to the limit`,
  ),
  capLineOpen: p("شوف مين هنّ", "See who they are"),
  seeTheQueue: p("افتح الطابور", "Open the queue"),
  systemTitle: p("النظام", "System"),
  deploymentSilent: p(
    "هالنشرة ما ردّت على فحص النشر لسا.",
    "This deployment has not answered the audit yet.",
  ),
  deploymentAllWell: p(
    "كل اللي انفحص بيطابق اللي بتفترضه الشيفرة.",
    "Everything checked matches what the code assumes.",
  ),
  perPlan: p("لكل خطّة", "Per plan"),

  /*
    A line under each screen's name, and the reason every screen has one.

    The console used to carry one sentence at the top of one page, and eight
    headings under it. A heading names a table; it does not say what the table
    is for or what a bad number in it would mean, and the person reading this
    at two in the morning is the person least able to reconstruct that. One
    line each, and each one says what the screen is *for* rather than what is
    on it.
  */
  leadInsights: p(
    "هل المنصّة كويسة، ولوين رايحة خلال أسبوعين.",
    "Whether the platform is well right now, and where it is heading over a fortnight.",
  ),
  leadAttention: p(
    "كل شي بدّه إنسان، سطر سطر، والأسوأ أوّل.",
    "Everything that needs a person, one row at a time, worst first.",
  ),
  leadAccounts: p(
    "مين عنّا، وشو صرف، ومين مستني على الباب.",
    "Who is here, what they have spent, and who is waiting at the door.",
  ),
  leadRenders: p(
    "كل تنفيذ وشو قاله عن حاله لمّا نجح ولمّا فشل.",
    "Every render, and what the renderer said about itself when it worked and when it did not.",
  ),
  leadPosting: p(
    "الطابور التاني: شو انوعد فيه جمهور وهل طلع فعلًا.",
    "The other queue: what an audience was promised, and whether it actually went out.",
  ),
  leadMoney: p(
    "شو بيدخل كل شهر، ومن وين، وأي دفعة وصلت وما انطبّقت.",
    "What comes in each month, from where, and which payment arrived and did not apply.",
  ),
  leadSystem: p(
    "العامل، ووين بتخالف هالنشرة الشيفرة اللي شغّالة عليها، وشو منخزّن.",
    "The worker, where this deployment disagrees with the code on it, and what we are storing.",
  ),
  leadLog: p(
    "كل فعل انتنفّذ من هون، ومين نفّذه وليش.",
    "Every act performed from here, by whom, and why.",
  ),

  consoleTag: p("تشغيل", "console"),
  readAt: f<[string]>((ago) => `انقرت قبل ${ago}`, (ago) => `read ${ago} ago`),
  readJustNow: p("انقرت من شوي", "read just now"),

  /* The fortnight, as a chart rather than as four thumbnails. */
  fortnightTitle: p("أربعة عشر يومًا", "The last fourteen days"),
  fortnightLead: p(
    "سلسلة وحدة بالمرّة: الدقايق والإخفاقات ما بيشتركوا بمقياس، وجمعهم على محور واحد بيخلّي الإخفاقات خطّ مسطّح عند القاع.",
    "One series at a time: minutes and failures share no scale, and putting them on one axis flattens the failures along the bottom.",
  ),
  fortnightEmpty: p(
    "ما وصل لسا أربعتعش يوم من الأرقام من هالنشرة.",
    "This deployment has not answered with a fortnight of numbers yet.",
  ),
  seriesRenders: p("تنفيذات", "Renders"),
  seriesMinutes: p("دقائق", "Minutes"),
  seriesFailures: p("إخفاقات", "Failures"),
  seriesSignups: p("تسجيلات", "Signups"),

  /* Empty states, which used to be one word each. */
  nothingHereYet: p("ما في شي هون لسا", "Nothing here yet"),
  allApplied: p("كل اللي وصل انطبّق.", "Everything that arrived applied."),

  thisWeekNoneLast: f<[number]>(
    (count) => `${count} هالأسبوع، وما في شي قبله`,
    (count) => `${count} this week, none last`,
  ),
  levelWithLastWeek: p("متل الأسبوع الماضي", "level with last week"),
  changeOnLastWeek: f<[string, number]>(
    (direction, percent) => `${direction} ${percent}% عن الأسبوع الماضي`,
    (direction, percent) => `${direction} ${percent}% on last week`,
  ),
  up: p("ارتفاع", "up"),
  down: p("انخفاض", "down"),
} as const;
