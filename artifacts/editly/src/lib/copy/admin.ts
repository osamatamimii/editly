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
    "للقراءة فقط. كل رقم هنا يأتي من الوحدات نفسها التي يفوتر بها المنتج ويجدول.",
    "Read-only. Every number here comes from the same modules the product bills and schedules with.",
  ),
  didNotWork: p("لم ينجح ذلك.", "That did not work."),
  loading: p("جارٍ التحميل…", "Loading…"),
  never: p("أبدًا", "never"),
  yes: p("نعم", "yes"),
  no: p("لا", "no"),
  all: p("الكل", "all"),

  reasonLabel: p(
    "السبب (مطلوب قبل تنفيذ أي شيء أدناه)",
    "Reason (required before anything below can be done)",
  ),
  reasonPlaceholder: p(
    "لماذا تفعل هذا؟ يُكتب في السجلّ باسمك.",
    "Why are you doing this? It goes in the log with your name.",
  ),
  typeReasonFirst: p("اكتب سببًا أوّلًا", "Type a reason first"),

  usageTitle: p("التخزين، وكم يكلّف نقله", "Storage, and what moving it costs"),
  thisMonth: p("هذا الشهر", "this month"),
  stored: p("المخزَّن", "Stored"),
  notKnown: p("غير معروف", "not known"),
  storageSilent: p("لم يجب التخزين", "storage did not answer"),
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
    "التنفيذات التي سبقت القياس ليست في المجموع، فالرقم الحقيقي أعلى.",
    "Renders from before this was measured are not in the total, so the real figure is higher.",
  ),

  deploymentTitle: p("هذه النشرة مقابل الشيفرة", "This deployment against the code"),
  deploymentSummary: f<[number, number, number]>(
    (wrong, unknown, ok) => `${wrong} خطأ · ${unknown} مجهول · ${ok} سليم`,
    (wrong, unknown, ok) => `${wrong} wrong · ${unknown} unknown · ${ok} fine`,
  ),
  expects: p("يتوقّع", "expects"),
  actually: p("فعليًّا", "actually"),

  renderingNow: p("يُنفَّذ الآن", "Rendering now"),
  waitingInQueue: p("في الطابور", "Waiting in queue"),
  behindLiveMachine: p("خلف جهاز يعمل", "behind a live machine"),
  unattended: p("بلا جهاز", "Unattended"),
  unattendedHint: p("في الطابور ولا أحد يسمع", "queued with nothing listening"),
  failedDay: p("فشلت (24 ساعة)", "Failed (24h)"),
  worker: p("الجهاز", "Worker"),
  workerUnclear: p("غير واضح", "unclear"),
  workerOnline: p("يعمل", "online"),
  workerOffline: p("متوقّف", "offline"),
  workerContradiction: f<[string]>(
    (ago) => `الخادم يقول إنه يعمل، وآخر نبضة قبل ${ago}. لا يصحّ الاثنان.`,
    (ago) => `the server says online, but the last beat was ${ago} ago. Both cannot be true.`,
  ),
  neverSeen: p("لم يُرَ قطّ", "never seen"),
  lastBeat: f<[string]>((ago) => `آخر نبضة قبل ${ago}`, (ago) => `last beat ${ago} ago`),
  doneDay: p("اكتملت (24 ساعة)", "Done (24h)"),
  minutesThisMonth: p("الدقائق هذا الشهر", "Minutes this month"),
  accounts: p("الحسابات", "Accounts"),
  newThisWeek: f<[number]>(
    (count) => `${count} جديدة هذا الأسبوع`,
    (count) => `${count} new this week`,
  ),

  postingTitle: p("النشر", "Posting"),
  overdue: p("فات وقتها", "Overdue"),
  overdueHint: p("تجاوزت وقتها ولم يلتقطها أحد", "past their time, unclaimed"),
  midSend: p("في منتصف الإرسال", "Mid-send"),
  midSendHint: p("توقّف الناشر عن حملها", "a publisher stopped holding these"),
  dueWithinHour: p("يحين خلال ساعة", "Due within the hour"),
  postedDay: p("نُشرت (24 ساعة)", "Posted (24h)"),
  tooLateToSend: f<[number]>(
    (count) => `${count} فات وقت إرسالها`,
    (count) => `${count} too late to send`,
  ),

  subscriptions: p("الاشتراكات", "Subscriptions"),
  monthlyRecurring: f<[number]>((usd) => `$${usd} / شهريًا`, (usd) => `$${usd} / month`),
  lastBillingEvents: p("آخر أحداث الفوترة", "Last billing events"),
  headType: p("النوع", "Type"),
  headEmail: p("البريد", "Email"),
  headPlan: p("الخطّة", "Plan"),
  headReceived: p("وصل", "Received"),
  headApplied: p("طُبِّق", "Applied"),
  headOutcome: p("النتيجة", "Outcome"),
  nothingFromFreemius: p("لا شيء من Freemius بعد.", "Nothing from Freemius yet."),

  searchByEmail: p("ابحث بالبريد", "Search by email"),
  headMinutes: p("الدقائق", "Minutes"),
  headProjects: p("المشاريع", "Projects"),
  headJoined: p("انضمّ", "Joined"),
  headLastSeen: p("آخر ظهور", "Last seen"),
  grantMinutes: p("‏+30 دقيقة", "+30 min"),
  suspend: p("علِّق", "Suspend"),
  nobodyYet: p("لا أحد بعد.", "Nobody yet."),

  waitlistTitle: p("قائمة الانتظار", "Waiting list"),
  waiting: f<[number]>((count) => `${count} في الانتظار`, (count) => `${count} waiting`),
  headFrom: p("من", "From"),
  nobodyAsked: p("لم يطلب أحد بعد.", "Nobody has asked yet."),

  recentRenders: p("أحدث التنفيذات", "Recent renders"),
  headStatus: p("الحالة", "Status"),
  headProject: p("المشروع", "Project"),
  headBilled: p("المفوتَر", "Billed"),
  headCreated: p("أُنشئ", "Created"),
  headFinished: p("انتهى", "Finished"),
  headWhatTheyWereTold: p("ما قيل لهم، وما حدث", "What they were told, and what happened"),
  headWhatItDid: p("ما فعله", "What it did"),
  requeue: p("أعده للطابور", "Requeue"),
  noRendersYet: p("لا تنفيذات بعد.", "No renders yet."),
  unattendedSuffix: f<[string]>(
    (status) => `${status} · بلا جهاز`,
    (status) => `${status} · unattended`,
  ),

  logTitle: p("ما فُعل هنا", "What has been done here"),
  logLead: p("كل فعل أعلاه يكتب سطرًا. ولا شيء يزيل سطرًا.", "Every action above writes a row. Nothing removes one."),
  headWhen: p("متى", "When"),
  headAction: p("الفعل", "Action"),
  headSubject: p("المعنيّ", "Subject"),
  headReason: p("السبب", "Reason"),
  headDetail: p("التفصيل", "Detail"),
  nothingDoneYet: p("لم يُفعل شيء هنا بعد.", "Nothing has been done here yet."),

  nothingNeedsYou: p("لا شيء يحتاجك.", "Nothing needs you."),
  allClear: p(
    "هناك جهاز يسمع، والطابور يتحرّك، وكل دفعة وصلت طُبِّقت.",
    "A machine is listening, the queue is moving, and every payment that arrived has been applied.",
  ),
  thingsNeedYou: f<[number]>(
    (count) => (count === 1 ? "أمر واحد يحتاجك" : `${count} أمور تحتاجك`),
    (count) => (count === 1 ? "One thing needs you" : `${count} things need you`),
  ),
  workerContradicts: p(
    "الجهاز يقول إنه يعمل ونبضته قديمة. لا يصحّ الاثنان.",
    "The worker reports online with a stale heartbeat. Both cannot be true.",
  ),
  nobodyListening: p(
    "لا جهاز يسمع. لن يُنفَّذ شيء حتى يعود واحد.",
    "No machine is listening. Nothing will render until one comes back.",
  ),
  unattendedProblem: f<[number]>(
    (count) =>
      count === 1
        ? "تنفيذ واحد في الطابور ولا شيء يلتقطه."
        : `${count} تنفيذات في الطابور ولا شيء يلتقطها.`,
    (count) =>
      `${count} ${count === 1 ? "render is" : "renders are"} queued with nothing to pick ${count === 1 ? "it" : "them"} up.`,
  ),
  failedProblem: f<[number]>(
    (count) =>
      count === 1
        ? "تنفيذ واحد فشل في اليوم الأخير. والسبب على سطره أدناه."
        : `${count} تنفيذات فشلت في اليوم الأخير. والسبب على كل سطر أدناه.`,
    (count) =>
      `${count} ${count === 1 ? "render" : "renders"} failed in the last day. The reason is on each row below.`,
  ),
  overdueProblem: f<[number]>(
    (count) =>
      count === 1
        ? "منشور مجدول واحد فات وقته ولم يلتقطه أحد. الناشر لا يكنس، ولن يُخبَر أحد."
        : `${count} منشورات مجدولة فات وقتها ولم يلتقطها أحد. الناشر لا يكنس، ولن يُخبَر أحد.`,
    (count) =>
      `${count} scheduled ${count === 1 ? "post is" : "posts are"} past their time and unclaimed. The publisher is not sweeping, and nobody will be told.`,
  ),
  strandedProblem: f<[number]>(
    (count) =>
      count === 1
        ? "منشور واحد كان في منتصف الإرسال حين توقّف ناشر. ولا يُعرف إن خرج."
        : `${count} منشورات كانت في منتصف الإرسال حين توقّف ناشر. ولا يُعرف إن خرجت.`,
    (count) =>
      `${count} ${count === 1 ? "post was" : "posts were"} mid-send when a publisher stopped. It is not known whether ${count === 1 ? "it" : "they"} went out.`,
  ),
  reconnectProblem: f<[number]>(
    (count) =>
      count === 1
        ? "حساب مربوط واحد يحمل مفتاحًا لم تعد المنصّة تقبله. وكل منشور مجدول إليه سيفشل عند موعده."
        : `${count} حسابات مربوطة تحمل مفاتيح لم تعد المنصّة تقبلها. وكل منشور مجدول إليها سيفشل عند موعده.`,
    (count) =>
      `${count} connected ${count === 1 ? "account has" : "accounts have"} a token the platform no longer accepts. Every post scheduled to ${count === 1 ? "it" : "them"} will fail as it comes due.`,
  ),
  billingProblem: f<[number]>(
    (count) =>
      count === 1
        ? "حدث فوترة واحد وصل ولم يُطبَّق. أحدهم دفع مقابل شيء لا يملكه."
        : `${count} أحداث فوترة وصلت ولم تُطبَّق. أحدهم دفع مقابل شيء لا يملكه.`,
    (count) =>
      `${count} billing ${count === 1 ? "event" : "events"} arrived and did not apply. Somebody has paid for something they do not have.`,
  ),

  thisWeekNoneLast: f<[number]>(
    (count) => `${count} هذا الأسبوع، ولا شيء قبله`,
    (count) => `${count} this week, none last`,
  ),
  levelWithLastWeek: p("مثل الأسبوع الماضي", "level with last week"),
  changeOnLastWeek: f<[string, number]>(
    (direction, percent) => `${direction} ${percent}% عن الأسبوع الماضي`,
    (direction, percent) => `${direction} ${percent}% on last week`,
  ),
  up: p("ارتفاع", "up"),
  down: p("انخفاض", "down"),
} as const;
