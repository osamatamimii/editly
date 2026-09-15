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
    /*
      The drawer's own two words.

      The bar used to hold these four links, the language switch and two doors
      — seven things arguing with each other and with the box under the
      headline, which is the one thing the page now asks anybody to do. They
      are behind a menu at every width now, rather than merely `hidden` below
      `lg`, which is what they were: a phone could not reach Pricing at all.
    */
    menu: p("القائمة", "Menu"),
    close: p("إغلاق", "Close"),
  },

  header: {
    logIn: p("تسجيل الدخول", "Log in"),
    /* The same door, named in one word.

       «تسجيل الدخول» is four syllables and 110 pixels wide, and on a 390px
       phone the Arabic header needed 390 of the 388 it had: the wordmark was
       squeezed to 53px by `min-w-0` and «Editly» ran out of its own box and
       under the language switch. English never showed it, because "Log in" is
       half the width. Measured at 390, in both directions. */
    logInShort: p("دخول", "Log in"),
    signUp: p("حساب جديد", "Sign up"),
    signUpFree: p("ابدأ مجانًا", "Sign up free"),
    dashboard: p("لوحتك", "Dashboard"),
  },

  hero: {
    /*
     * One sentence.
     *
     * What was here was a two-part signature: "Stop editing." set in a heavy
     * grotesque, then "Start describing." answering it in an italic serif on a
     * gradient. It was a nice piece of setting and it was still a slogan —
     * two half-lines, a typographic joke between them, and nothing in either
     * one that says what you get.
     *
     * The line below says the whole deal in five words: you talk, the video
     * comes back finished. It is the claim, not a posture about the claim,
     * which is why it does not need two voices to carry it.
     */
    headline: p("احكي، وخُد الفيديو جاهز.", "Say it. Get the video."),
    /*
     * The line under the headline says something the headline did not.
     *
     * It used to read "One sentence. A finished video." — which was the
     * headline again, one synonym over. Two lines that make the same claim
     * are one line and a wasted one, and the wasted one is directly under
     * the largest type on the page.
     *
     * So this one is the concrete work: what the machine actually does to
     * the footage, in the order it does it, ending on the state the person
     * wants it in. The headline makes the promise; this says what the
     * promise is made of.
     */
    subtext: p(
      "بيقصّ السكتات، وبيكتب الكابشن، وبيرجع جاهز للنشر.",
      "Cuts the silences, writes the captions, comes back ready to post.",
    ),
    ctaSignedOut: p("ابدأ التعديل مجانًا", "Start editing free"),
    ctaSignedIn: p("ارفع تسجيلًا خامًا", "Upload a raw take"),
    secondary: p("شوف كيف يعمل", "See how it works"),

    /*
     * The box that replaced the two buttons.
     *
     * A button asks somebody to commit before they have seen anything. A box
     * asks them to say what they want, which is easier and is also the thing
     * this product is for — the headline one line up tells them to describe
     * rather than edit, and until now the next thing on the page was a button
     * that did not let them.
     *
     * The placeholder is a real request this editor takes, not "type
     * something": the fastest way to teach what a sentence to this product
     * looks like is to have one already written in the shape of the box.
     */
    composerLabel: p("احكي التعديل اللي بدّك ياه", "Describe the edit you want"),
    composerPlaceholder: p(
      "اقصّ السكتات، وحطّ كابشن عربي، وخلّيه عمودي…",
      "Cut the silences, caption it, make it vertical…",
    ),
    composerAttach: p("أرفق فيديو", "Attach a video"),
    composerSend: p("ابدأ", "Start"),
    composerRemoveFile: p("شيل الملفّ", "Remove the file"),
    composerNotVideo: p("ما منقدر نستعمل هالملفّ", "We cannot use that file"),
    caption: p(
      "تعديل حقيقي: 12.3 ثانية صارت 6.5.",
      "A real edit: 12.3s became 6.5s.",
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
    intro: p("هاد اللي رح أعمله، قبل ما أعمله:", "Here is what I will do, before I do it:"),
    planCutSilence: p("أقصّ كل صمت أطول من 0.4 ثانية", "Cut every silence longer than 0.4s"),
    planReframe: p("أعيد الكادر لـ9:16 وأخلّيك بالصورة", "Reframe to 9:16, keeping you in frame"),
    planCaptions: p("أكتب الكابشن من كلامك إنت", "Burn in captions from what you said"),
    planLevel: p("أظبّط الصوت لـ−14 LUFS", "Level the audio to −14 LUFS"),
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
        "الخام، بكل التردّد والإعادات.",
        "The raw one, ums and restarts included.",
      ),
      // Inside the drawing. A file name and a duration read the same in both.
      file: p("raw-take.mov", "raw-take.mov"),
      duration: p("12:04", "12:04"),
    },
    two: {
      title: p("قل ما تريد", "Say what you want"),
      desc: p(
        "«اقصّ الفراغات وخلّيه عمودي.» وبيقول لك شو رح يعمل قبل ما يعمله.",
        '"Cut the dead air, make it vertical." It says what it will do before it does it.',
      ),
      askLine1: p("اقصّ الفراغات وخلّيه", "Cut the dead air and make it"),
      askLine2: p("عموديًا لتيك توك.", "vertical for TikTok."),
      planSilence: p("أشيل 41 ثانية من الصمت", "Remove 41s of silence"),
      planReframe: p("أعيد الكادر لـ9:16", "Reframe to 9:16"),
      planCaptions: p("أكتب الكابشن", "Burn in your captions"),
      planLoudness: p("أظبّط الصوت لـ−14 LUFS", "Level the audio to −14 LUFS"),
      // Inside the drawing: who is answering, and the line he opens with.
      noah: p("نوح", "Noah"),
      before: p("هاد اللي رح أعمله، قبل ما أعمله:", "Here is what I will do, before I do it:"),
    },
    three: {
      title: p("انشره", "Post it"),
      desc: p(
        "مؤطَّر لتيك توك وريلز وشورتس.",
        "Framed for TikTok, Reels and Shorts.",
      ),
      source: p("مصدر 16:9", "16:9 source"),
      output: p("9:16", "9:16"),
      loudness: p("−14 LUFS", "−14 LUFS"),
    },
  },

  /*
   * What it does, one claim at a time.
   *
   * Five outcomes, not eleven mechanics. This was a checklist of everything the
   * renderer can do, one switch per line, and a list that long is read as a
   * list — skimmed, and none of it landing. Nothing has been dropped from the
   * product: each line here is the result, with the mechanics that produce it
   * underneath where they belong.
   *
   * Kept honest by hand: everything named works today, and what is not built
   * stays off the list. That honesty cuts both ways, so `browser-test` checks
   * the claims against what shipped in both directions.
   *
   * `prompt` is the sentence under each one, and it is not decoration. Every
   * one of them is run through the product's own keyword planner by
   * `tools/feature-scroll-test.mjs`, in both languages, and pressing it carries
   * the sentence into the app. A prompt on a landing page that the product
   * would not understand is the most embarrassing lie available to us.
   */
  features: {
    eyebrow: p("الميزات", "Features"),
    title: p("ما الذي يفعله اليوم", "What it does today"),
    lead: p(
      "خمسة أشياء، كلها شغّالة اليوم.",
      "Five things, all working today.",
    ),
    tryIt: p("جرّب:", "Try:"),
    list: [
      {
        title: p("تسجيل خام يصير منشورًا", "A raw take becomes a post"),
        detail: p(
          "كل صمت مقصوص، والكادر مظبوط، والصوت معايَر.",
          "Silences cut, framing fixed, levels set.",
        ),
        prompt: p("اقصص الصمت وضيف ترجمة، عمودي لتيك توك", "Cut the silences and caption it, vertical for TikTok"),
      },
      {
        title: p("اللحظات التي تستحقّ، تُلتقَط لك", "The moments worth keeping, found for you"),
        detail: p(
          "أقوى 30 ثانية، أو التسجيل كلّه مقصوص لقصاصات معنونة.",
          "The strongest 30 seconds, or the whole take cut into titled clips.",
        ),
        prompt: p("قسّمه إلى 3 مقاطع لريلز", "Cut it into 3 clips for Reels"),
      },
      {
        title: p("كابشن بكلامك أنت", "Captions in your own words"),
        detail: p(
          "من كلامك لا من قالب. عربي أو إنجليزي.",
          "From what you said, not a template. Arabic or English.",
        ),
        prompt: p("ضيف ترجمة وظبط الصوت ليوتيوب", "Caption it and level the audio for YouTube"),
      },
      {
        title: p("يبدو معدَّلًا لا معالَجًا", "It looks edited, not processed"),
        detail: p(
          "ذوبان بين القطعات، وموسيقى تخفت تحت صوتك، ولوك لوني.",
          "Dissolves, music that ducks under your voice, and a grade.",
        ),
        prompt: p("خلّيه سينمائي مع تلاشي بالبداية والنهاية", "Make it cinematic, fade in and out"),
      },
      {
        title: p("ينهي العمل من دونك", "It finishes without you"),
        detail: p(
          "سكّر التبويب والتنفيذ بيكمّل. ولقطاتك خاصّة فيك.",
          "Close the tab; it keeps going. Your footage stays yours.",
        ),
        prompt: p("شدّه وابدأ بالأقوى", "Tighten it up and start with the best bit"),
      },
    ],
  },

  /*
   * The wall of finished clips, and the phone in front of it.
   *
   * Three real exports play there rather than a drawing of them, so the copy
   * does not have to describe what a finished clip looks like — the section
   * is showing three.
   */
  reel: {
    eyebrow: p("المُخرَج", "The output"),
    title: p("هذا ما يخرج منها", "This is what comes out"),
    lead: p(
      "عمودي، مكتوب الكابشن، معايَر الصوت. ثلاثة مقاطع حقيقية، تشتغل الآن.",
      "Vertical, captioned, levelled. Three real exports, playing now.",
    ),
    note: p("مقاطع خرجت من Editly، بلا قصّ يدوي", "Cut by Editly, with nobody trimming anything"),
    // On the phone's screen. The chips are requests this editor actually
    // takes, and the placeholder is the app's own.
    chipSilence: p("اقصّ الصمت", "Cut the silence"),
    chipVertical: p("عمودي 9:16", "Vertical 9:16"),
    placeholder: p("اكتب تعديلك…", "Write your edit…"),
  },
  podcasts: {
    eyebrow: p("البودكاست والقصاصات", "Podcasts and clipping"),
    title: p(
      "تسجيل واحد الثلاثاء. أسبوع من المنشورات بحلول الأربعاء.",
      "One recording on Tuesday. A week of posts by Wednesday.",
    ),
    lead: p(
      "بالساعتين تلات لحظات تستحقّ النشر. هاد بيلاقيهم.",
      "Two hours hold three moments worth posting. This finds them.",
    ),
    steps: [
      {
        step: p("التسجيل كلّه يدخل", "The whole take goes in"),
        detail: p(
          "ساعتان بملفّ واحد. وأربعة على Pro.",
          "Two hours in one file. Four on Pro.",
        ),
      },
      {
        step: p("اللحظات تُلتقَط", "The moments are found"),
        detail: p(
          "من الكلام، مش من الموجة. تلاتة تستحقّ، مش عشرة.",
          "From what was said, not the waveform. Three, not ten.",
        ),
      },
      {
        step: p("كل واحدة منشور جاهز", "Each one is a finished post"),
        detail: p(
          "عمودية، مكتوبة، معايَرة، ومسمّاة.",
          "Vertical, captioned, levelled, named.",
        ),
      },
    ],
    // Labels for the drawing, which is the section's real argument. They are
    // read aloud rather than seen, so they say what the picture shows.
    diagramTake: p(
      "ساعتان، تلات لحظات، وتحت كل وحدة قصاصتها",
      "Two hours, three moments, each with the clip it becomes",
    ),
    diagramClips: p("ثلاث قصاصات", "Three clips"),
    cta: p("اقصّ أوّل تسجيل لك", "Cut your first recording"),
    // Two template names, said in the middle of a sentence. Split so the names
    // stay set in bold without a translated string having to carry markup.
    noteLead: p("قالبان بضغطة وحدة بيعملوا هاد:", "Two one-click looks do this:"),
    noteThreeClips: p("ثلاث قصاصات", "Three clips"),
    noteAnd: p("و", "and"),
    notePodcastClip: p("قصاصة بودكاست", "Podcast clip"),
    noteTail: p("وكلاهما على الخطّة المجانية.", "Both are on the free plan."),
  },

  pricing: {
    title: p(
      "ادفع على الدقائق اللي بتنشرها.",
      "Pay for the minutes you publish.",
    ),
    lead: p(
      "كل الخطط بتعدّل نفس الشي. والرفع مفتوح.",
      "Every plan edits the same. Upload what you like.",
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
    /*
     * Shortened once too far, and `pricing-test` caught it.
     *
     * The copy pass that cut every long line on this page cut "card required"
     * out of here. The sentence still read well and it now said that the paid
     * plans open a seven-day trial without saying that the trial takes the
     * card first — which is the one fact in it somebody could be surprised by,
     * and the reason the suite pins this string at all. Brevity is not a
     * licence to drop the disclosure; it is a reason to say it in two words.
     *
     * The seven is written 7 and not ٧ for the same reason the prices are:
     * the suite reads the number out of the English and requires the Arabic
     * to carry the same one, and a number nobody can compare is a number that
     * drifts.
     */
    footnote: p(
      "المجاني بلا بطاقة · المدفوع: تجربة 7 أيام، البطاقة مطلوبة · بتلغي وقت ما بدك",
      "Free needs no card · Paid: 7-day trial, card required · Cancel anytime",
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
      "3 دقائق فيديو منتهٍ في الشهر",
      "ارفع مقاطع حتى 20 دقيقة",
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
