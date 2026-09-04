/**
 * Every sentence on the landing page, in both languages.
 *
 * The product is bilingual all the way down. A render note, a refusal, a clip
 * title and every reply Noah gives has an Arabic text and an English one, and
 * the matcher that turns a sentence into an edit reads both. The landing page
 * was the one surface that did not: the first audience is Arabic-speaking and
 * the first thing they were shown was in English.
 *
 * ## Why a file rather than two pages
 *
 * A second page is a second thing to keep true. This page states what the
 * product does, and what it does changes: the clips feature shipped and the
 * list had to learn about it, the free tier moved and the card had to say so.
 * Two copies of that page drift the way the OpenAPI file drifted, and the half
 * that drifts is always the half fewer people read. Here the two languages sit
 * on the same line, so a sentence cannot be changed in one and not the other
 * without it being visible in the diff, and `tools/landing-test.mjs` fails when
 * one side of a pair is missing, when they disagree about a number, or when
 * English is left sitting inside the Arabic.
 *
 * ## The Arabic is written, not translated
 *
 * Translated marketing copy reads as translated, and an audience can tell in
 * one line. So these are written as Arabic sentences that make the same claim,
 * not as the English put through a dictionary: «توقّف عن المونتاج» is what a
 * person actually says, and it is shorter and harder than "stop editing" is in
 * English. Where a claim has no natural Arabic form it is made differently
 * rather than made awkwardly.
 *
 * Product names stay in Latin script on purpose. TikTok, Reels, Shorts,
 * YouTube, LUFS and Editly are what they are called in Arabic too, and
 * transliterating a platform's name is how you look like you have not used it.
 * `tools/landing-test.mjs` holds the list, so a *new* English word appearing in
 * an Arabic sentence is a failure rather than a habit.
 *
 * ## Numbers are the same number
 *
 * Every figure on this page is one the product will actually honour: the plan
 * minutes, the prices, the free tier's five minutes, the 12.3 seconds the
 * renderer measured. The suite pulls the digits out of both sides of every pair
 * and fails when they differ, because a price that is right in one language and
 * wrong in the other is worse than a page with no price on it.
 */

export type Language = "ar" | "en";

/** One thing to say, in both languages. Never one language with a fallback. */
export interface Phrase {
  ar: string;
  en: string;
}

/** The default, and the reason this file exists. */
export const DEFAULT_LANGUAGE: Language = "ar";

export function isLanguage(value: unknown): value is Language {
  return value === "ar" || value === "en";
}

/** Which way a language reads. */
export function directionOf(language: Language): "rtl" | "ltr" {
  return language === "ar" ? "rtl" : "ltr";
}

export function say(phrase: Phrase, language: Language): string {
  return phrase[language];
}

/**
 * A phrase with a hole in it.
 *
 * A sentence carrying a number or a name cannot be a pair of strings, because
 * the two languages do not put the hole in the same place, and half of them do
 * not put it in the same clause. So the pair holds two functions and each
 * language writes its own sentence around the value, which is the only way an
 * Arabic sentence gets to be an Arabic sentence rather than English word order
 * with the words changed.
 *
 * It lives here beside `Phrase` because it is the same primitive; the product's
 * own table is `lib/app-copy.ts`.
 */
export interface Template<A extends unknown[]> {
  ar: (...args: A) => string;
  en: (...args: A) => string;
}

export const template = <A extends unknown[]>(
  ar: (...args: A) => string,
  en: (...args: A) => string,
): Template<A> => ({ ar, en });

export function fill<A extends unknown[]>(t: Template<A>, language: Language, ...args: A): string {
  return t[language](...args);
}

const p = (ar: string, en: string): Phrase => ({ ar, en });

/**
 * A pair built at render time, for the four places the English half already
 * lives somewhere better. See `PRICING_AR` at the foot of this file.
 */
export const phrase = p;

export const LANDING = {
  /** The control itself, labelled in the language it switches *to*. */
  languageToggle: {
    label: p("English", "العربية"),
    title: p("Read this page in English", "اقرأ هذه الصفحة بالعربية"),
  },

  nav: {
    features: p("الميزات", "Features"),
    podcasts: p("البودكاست", "Podcasts"),
    howItWorks: p("كيف يعمل", "How it works"),
    pricing: p("الأسعار", "Pricing"),
  },

  header: {
    logIn: p("تسجيل الدخول", "Log in"),
    signUp: p("حساب جديد", "Sign up"),
    signUpFree: p("ابدأ مجانًا", "Sign up free"),
    dashboard: p("لوحتك", "Dashboard"),
  },

  hero: {
    badge: p("تعرّف على نوح. قل له ما تريد", "Meet Noah. Tell him what you want"),
    // Two lines, and the second one is set differently: an italic serif in
    // English, and weight in Arabic, because Arabic has no italic. See
    // `.headline-serif` in index.css.
    headlineLead: p("توقّف عن المونتاج.", "Stop editing."),
    headlineAnswer: p("ابدأ بالوصف.", "Start describing."),
    subtext: p(
      "ارفع التسجيل الخام. صف التعديل. استرجع ثلاث ساعات من مسائك، مع كل فيديو.",
      "Upload the raw take. Describe the edit. Get three hours of your evening back, on every video.",
    ),
    ctaSignedOut: p("ابدأ التعديل مجانًا", "Start editing free"),
    ctaSignedIn: p("ارفع تسجيلًا خامًا", "Upload a raw take"),
    secondary: p("شوف كيف يعمل", "See how it works"),
    caption: p(
      "تعديل حقيقي واحد: 12.3 ثانية دخلت و6.5 خرجت. كل رقم هنا خرج من الرندر نفسه.",
      "One real edit: 12.3 seconds in, 6.5 out. Every number here is one the renderer produced.",
    ),
  },

  /**
   * The drawing of the editor in the hero.
   *
   * It is real DOM and real type rather than a screen recording, which is what
   * makes it translatable at all: a recording of the app in English is an
   * English picture on an Arabic page, and no amount of copy underneath fixes
   * that. Because it is drawn, it speaks whichever language the page is in.
   */
  heroEditor: {
    projectTitle: p("حلقة بودكاست 14", "Podcast episode 14"),
    status: p("جاهز", "done"),
    exportLabel: p("تصدير", "Export"),
    generate: p("نفّذ التعديل", "Generate Edit"),
    rawTake: p("التسجيل الخام", "The raw take"),
    silencesLead: p("4 مواضع صمت ·", "4 silences found ·"),
    deadAirAmount: p("5.8 ثانية", "5.8s"),
    silencesTail: p("من الفراغ", "of dead air"),
    ask: p(
      "اقصّ الفراغات وخلّيه عموديًا لتيك توك",
      "Cut the dead air and make it vertical for TikTok",
    ),
    assistant: p("نوح", "Noah"),
    intro: p("هذا ما سأفعله، قبل أن أفعله:", "Here is what I will do, before I do it:"),
    planCutSilence: p("قصّ كل صمت أطول من 0.4 ثانية", "Cut every silence longer than 0.4s"),
    planReframe: p("إعادة التأطير إلى 9:16 مع إبقائك في الكادر", "Reframe to 9:16, keeping you in frame"),
    planCaptions: p("حرق الكابشن من كلامك أنت", "Burn in captions from what you said"),
    planLevel: p("معايرة الصوت إلى −14 LUFS", "Level the audio to −14 LUFS"),
    resultTitle: p("تمّ. 12.3 ثانية صارت 6.5.", "Done. 12.3s became 6.5s."),
    resultDetail: p(
      "1080×1920 لتيك توك · 4 كابشنات محروقة · معايَر إلى −14 LUFS",
      "1080×1920 for TikTok · 4 captions burned in · levelled to −14 LUFS",
    ),
  },

  steps: {
    eyebrow: p("كيف يعمل", "How it works"),
    title: p("ثلاث خطوات، ولا واحدة منها مملّة", "Three steps, none of them tedious"),
    lead: p("الجزء الذي تكرهه، يُنجَز وأنت غير موجود.", "The part you dread, done while you are not looking."),
    one: {
      title: p("ارفع التسجيل الخام", "Upload the raw take"),
      desc: p(
        "غير المعدَّل، بكل التردّد والبدايات المكرّرة كما هي. هذا هو المقصود.",
        "The unedited one, with all the ums and restarts still in it. That is the point.",
      ),
      // Inside the drawing. A file name and a duration read the same in both.
      file: p("raw-take.mov", "raw-take.mov"),
      duration: p("12:04", "12:04"),
    },
    two: {
      title: p("قل ما تريد", "Say what you want"),
      desc: p(
        "«اقصّ الفراغات وخلّيه عموديًا لتيك توك.» ويقول لك Editly ماذا سيفعل بالضبط قبل أن يفعله.",
        '"Cut the dead air and make it vertical for TikTok." Editly tells you exactly what it will do before it does it.',
      ),
      askLine1: p("اقصّ الفراغات وخلّيه", "Cut the dead air and make it"),
      askLine2: p("عموديًا لتيك توك.", "vertical for TikTok."),
      planSilence: p("إزالة 41 ثانية من الصمت", "Remove 41s of silence"),
      planReframe: p("إعادة التأطير إلى 9:16", "Reframe to 9:16"),
      planCaptions: p("حرق الكابشن", "Burn in your captions"),
    },
    three: {
      title: p("انشره", "Post it"),
      desc: p(
        "مؤطَّر لتيك توك أو ريلز أو شورتس، وينتظرك حين تعود.",
        "Framed for TikTok, Reels or Shorts, and waiting for you when you come back.",
      ),
      source: p("مصدر 16:9", "16:9 source"),
      output: p("9:16", "9:16"),
    },
  },

  features: {
    eyebrow: p("الميزات", "Features"),
    title: p("ما الذي يفعله اليوم", "What it does today"),
    tryIt: p("جرّبه بنفسك", "Try it yourself"),
    list: [
      {
        title: p("تسجيل خام يصير منشورًا", "A raw take becomes a post"),
        detail: p(
          "كل صمت وكل وقفة تُقصّ، والكادر يُعاد لتيك توك وريلز وشورتس (أو يوتيوب، أو مربّع)، والمستويات تُضبط. من جملة واحدة.",
          "Every silence and pause cut, framed for TikTok, Reels and Shorts (or YouTube, or square), and the levels fixed. From one sentence.",
        ),
      },
      {
        title: p("اللحظات التي تستحقّ، تُلتقَط لك", "The moments worth keeping, found for you"),
        detail: p(
          "أقوى ثلاثين ثانية في تسجيل طويل، أو التسجيل كلّه مقصوصًا إلى قصاصات منفصلة، كل واحدة معنونة بما قاله المتحدّث فعلًا. افتح أيّها وواصل التعديل.",
          "The strongest thirty seconds of a long take, or the whole thing cut into separate clips, each titled by what the speaker actually said. Open any of them and keep editing.",
        ),
      },
      {
        title: p("كابشن بكلامك أنت", "Captions in your own words"),
        detail: p(
          "محروق من كلامك لا من قالب. بالعربية أو الإنجليزية، ومصفوف في الاتجاه الذي تُقرأ به اللغة.",
          "Burned in from what you said, not from a template. In English or Arabic, laid out in the direction that language reads.",
        ),
      },
      {
        title: p("يبدو معدَّلًا لا معالَجًا", "It looks edited, not processed"),
        detail: p(
          "ذوبان بين القطعات، وموسيقاك تنخفض من طريق صوتك حين تتكلّم، ولوك لوني: دافئ، أو سينمائي، أو مطابق لمقطع أعجبك لونه.",
          "Dissolves between the cuts, your own music ducking out of the way while you talk, and a grade: warm, cinematic, or matched to a clip whose colour you liked.",
        ),
      },
      {
        title: p("ينهي العمل من دونك", "It finishes without you"),
        detail: p(
          "أغلق التبويب ويكمل الرندر. ولقطاتك تبقى خاصّة بحسابك وحده.",
          "Close the tab and the render carries on. Your footage stays private to your account.",
        ),
      },
    ],
    grid: [
      {
        label: p("لقطات إضافية", "B-roll"),
        hint: p("تُقحَم فوق التسجيل", "cut in over the take"),
      },
      {
        label: p("الفراغات", "Dead air"),
        hint: p("تُقصّ، لا تُشذَّب يدويًّا", "cut, not trimmed by hand"),
      },
      {
        label: p("الكابشن", "Captions"),
        hint: p("من كلامك أنت", "from what you said"),
      },
      {
        label: p("الانتقالات", "Transitions"),
        hint: p("ذوبان، لا قطع جافّ", "dissolved, not dropped"),
      },
    ],
  },

  podcasts: {
    eyebrow: p("البودكاست والقصاصات", "Podcasts and clipping"),
    title: p(
      "تسجيل واحد الثلاثاء. أسبوع من المنشورات بحلول الأربعاء.",
      "One recording on Tuesday. A week of posts by Wednesday.",
    ),
    lead: p(
      "حديث من ساعتين فيه ثلاث أو أربع لحظات تستحقّ النشر، والعثور عليها هو العمل كلّه. ارفع التسجيل، وقل ما تريد، وتعود كل لحظة قصاصة عمودية قائمة بذاتها: مكتوبة الكابشن، معايَرة الصوت، ومعنونة بما قيل فيها فعلًا.",
      "A two-hour conversation holds three or four moments worth posting, and finding them is the work. Upload the take, say what you want, and each moment comes back as its own vertical clip, captioned, levelled and titled by what was actually said in it.",
    ),
    steps: [
      {
        step: p("التسجيل كلّه يدخل", "The whole take goes in"),
        detail: p(
          "ساعتان، شخصان، ملفّ واحد. وحتى أربع ساعات على Pro. لا شيء يحتاج تشذيبًا أوّلًا، لأن التشذيب أوّلًا هو العمل نفسه.",
          "Two hours, two people, one file. Up to four hours on Pro. Nothing has to be trimmed first, because trimming it first is the job.",
        ),
      },
      {
        step: p("اللحظات تُلتقَط", "The moments are found"),
        detail: p(
          "تُقرأ ممّا قيل لا من الموجة الصوتية. وقصاصات أقلّ بدل الحشو إلى رقم: تسجيل طويل نادرًا ما يحمل أكثر من ثلاث تستحقّ النشر، فيعود بثلاث.",
          "Read from what is said, not from the waveform. Fewer clips rather than padding to a number: a long take rarely holds more than three worth posting, and it comes back with three.",
        ),
      },
      {
        step: p("كل واحدة منشور جاهز", "Each one is a finished post"),
        detail: p(
          "مقصوصة عموديًّا، بكابشن من كلام المتحدّث نفسه، معايَرة لما تطلبه المنصّات، ومسمّاة بالجملة التي تدور عليها. افتح أيّها وواصل التعديل.",
          "Cut vertical, captioned in the speaker's own words, levelled to what the platforms want, and named after the line it turns on. Open any of them and keep editing.",
        ),
      },
    ],
    cta: p("اقصّ أوّل تسجيل لك", "Cut your first recording"),
    // Two template names, said in the middle of a sentence. Split so the names
    // stay set in bold without a translated string having to carry markup.
    noteLead: p("قالبان من قوالب الضغطة الواحدة يفعلان هذا بالضبط:", "Two of the one-click looks do exactly this:"),
    noteThreeClips: p("ثلاث قصاصات", "Three clips"),
    noteAnd: p("و", "and"),
    notePodcastClip: p("قصاصة بودكاست", "Podcast clip"),
    noteTail: p("وكلاهما على الخطّة المجانية.", "Both are on the free plan."),
  },

  pricing: {
    title: p(
      "السعر على الدقائق التي تنشرها، لا الساعات التي تسجّلها",
      "Priced by the minutes you publish, not the hours you record",
    ),
    lead: p(
      "كل الخطط تعدّل بالطريقة نفسها. وارفع من اللقطات ما شئت.",
      "Every plan does the same editing. Upload as much footage as you like.",
    ),
    monthly: p("شهريًّا", "Monthly"),
    yearly: p("سنويًّا", "Yearly"),
    save: p("وفّر 20%", "Save 20%"),
    perMonth: p("/شهر", "/month"),
    perYear: p("/سنة", "/year"),
    minutesLabel: p("دقيقة فيديو منتهٍ", "minutes of finished video"),
    mostPopular: p("الأكثر اختيارًا", "Most Popular"),
    currentPlan: p("خطّتك الحالية", "Current Plan"),
    checkingPlan: p("نقرأ خطّتك…", "Checking your plan…"),
    openingCheckout: p("نفتح الدفع…", "Opening checkout…"),
    switching: p("نحوّل…", "Switching…"),
    switchTo: p("انتقل إلى", "Switch to"),
    get: p("اشترك في", "Get"),
    /*
      Where a subscription is actually stopped, which is not here.

      Freemius takes the payment, so switching to a smaller plan on this page
      changes what the account may do and leaves the card running. The sentence
      beside this link comes from the server, which knows which plan was being
      paid for; this is the way out of it.
    */
    cancelWhereBought: p("ألغِ الاشتراك حيث اشتريته", "Cancel the subscription where you bought it"),
    /*
      Under the paid cards, so it says what a paid card actually does.

      It used to read "no credit card required" here, three centimetres above
      three buttons that open a Freemius checkout with `trial=paid` on the URL,
      which in their vocabulary means seven days with a card taken up front.
      `lib/checkout.ts` says so in its own comment. So somebody read "no card",
      pressed "Get Pro", and was asked for a card on the next screen. Nothing in
      this product failed. The sentence was simply about the free plan and
      printed under the paid ones.

      The free plan genuinely needs no card, and that half is kept and put where
      it is true. The paid half now says the thing a person is about to meet.
    */
    footnote: p(
      "المجاني بلا بطاقة · المدفوع: 7 أيام تجربة والبطاقة مطلوبة · ألغِ متى شئت",
      "Free needs no card · Paid plans: 7-day trial, card required · Cancel anytime",
    ),
  },

  closing: {
    title: p("اجعل فيديوك القادم أفضل ما صنعت.", "Turn your next video into your best one."),
    leadFirst: p("الجزء الممل هو ما يجب أن تفعله الآلة.", "The tedious part is the part a machine should do."),
    leadSecond: p("ارفع تسجيلًا واحدًا وانظر كم يقصر.", "Upload one take and see how much shorter it gets."),
    cta: p("ابدأ التعديل مجانًا", "Start Editing Free"),
    note: p("بلا بطاقة · ألغِ متى شئت", "No credit card required · Cancel anytime"),
  },

  footer: {
    product: p("المنتج", "Product"),
    account: p("الحساب", "Account"),
    earn: p("اكسب", "Earn"),
    howItWorks: p("كيف يعمل", "How it works"),
    features: p("الميزات", "Features"),
    podcasts: p("البودكاست والقصاصات", "Podcasts and clipping"),
    pricing: p("الأسعار", "Pricing"),
    logIn: p("تسجيل الدخول", "Log in"),
    createAccount: p("أنشئ حسابًا", "Create an account"),
    yourProjects: p("مشاريعك", "Your projects"),
    affiliate: p("كن شريكًا بالعمولة", "Become an affiliate"),
    affiliateTerms: p("25% من كل دفعة، لمدّة سنة.", "25% of every payment, for a year."),
    privacy: p("الخصوصية", "Privacy"),
    terms: p("الشروط", "Terms"),
    tagline: p("توقّف عن المونتاج. ابدأ بالوصف.", "Stop editing. Start describing."),
  },
} as const;

/**
 * The pricing card, in Arabic, and deliberately without its English twin.
 *
 * Every other string on this page is a pair, because both halves are this
 * file's to keep. These four are not: the English already lives in
 * `lib/pricing.ts`, and it lives there for a reason worth not undoing.
 * `tools/pricing-test.mjs` reads that module beside `plan-limits.ts` and fails
 * when the page promises minutes or an upload length the server will refuse.
 * Copying those sentences here would give the page a second English source that
 * nothing compares against the server, which is the exact shape of the drift
 * this product has already paid for twice.
 *
 * So the page builds the pair at render time: the Arabic from here, the English
 * from there. `tools/landing-test.mjs` pulls the digits out of both sides and
 * fails when they disagree, so «ارفع حتى 30 دقيقة» cannot survive a change from
 * thirty minutes to twenty.
 */
export const PRICING_AR = {
  plans: {
    creator: {
      forWho: "المحتوى القصير: تيك توك، ريلز، شورتس",
      upload: "ارفع حتى 30 دقيقة",
      yearlyPerMonth: "‏$9.6/شهر بفوترة سنوية",
    },
    pro: {
      forWho: "المحتوى الطويل: يوتيوب والبودكاست",
      upload: "ارفع حلقة من 4 ساعات ملفًّا واحدًا",
      yearlyPerMonth: "‏$23.25/شهر بفوترة سنوية",
    },
    studio: {
      forWho: "الفرق والوكالات",
      upload: "رفع حتى 10 ساعات، تصدير 4K، وأولوية في الطابور. قريبًا: 3 مقاعد، هوية بصرية، وواجهة برمجية",
      yearlyPerMonth: "‏$63.2/شهر بفوترة سنوية",
    },
  },
  shared: [
    "ارفع من اللقطات ما شئت. لا تدفع إلا عمّا تنشره",
    "بلا علامة مائية",
    "تعديلات بلا حدّ. وإعادة الطلب مجانية",
    "طابِق ستايل فيديو أعجبك",
  ],
  free: {
    headline: "جرّبها مجانًا، بلا بطاقة",
    lines: [
      "5 دقائق فيديو منتهٍ في الشهر",
      "ارفع مقاطع حتى 10 دقائق",
      /*
        The English said "Every editing feature, so you can judge the result"
        and the claim was withdrawn: `PLAN_LIMITS.free.referenceStyle` is
        false, so matching another video's look — the thing this codebase calls
        the feature nobody else does — is not on the free plan, and neither is
        4K. `pricing.ts` records the reasoning.

        The Arabic said the same thing and was not changed, which is worse than
        the original defect: Arabic is this product's default language, so the
        withdrawn claim went on being made to most of the people reading it.
        The guard did not catch it because `pricing-test` matches an English
        phrase and `landing-test` compares digits.

        The replacement is the same better claim: this is the product, not a
        demonstration of it.
      */
      "المحرّر نفسه، لا نسخة تجريبية، حتى تحكم على النتيجة",
      "الصادرات تحمل علامة Editly صغيرة",
    ],
  },
} as const;
