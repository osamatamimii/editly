/**
 * Every company this product sends a customer's data to, and what it sends.
 *
 * This is the list a privacy policy is made of, and it lives in code for one
 * reason: **the policy is a promise, and a promise nobody re-reads becomes a
 * lie by addition.** Somebody wires up a new transcription provider next
 * month, ships it, and the page still names the old three. Nothing fails, the
 * customer's audio is at a company they were never told about, and the first
 * person to notice is a regulator or a journalist.
 *
 * So the list is here, `tools/privacy-test.mjs` reads the outbound hosts out of
 * the source, and CI fails when the code talks to a host this file does not
 * name. The page is rendered from this list, so it cannot be older than the
 * code either.
 *
 * ## What belongs here
 *
 * A company that receives customer content or customer identity. Not every
 * host: a font downloaded from Google Fonts at build time receives nothing,
 * and listing it would pad the page with noise that hides the four entries
 * that matter.
 */

export type ProcessorRole =
  | "infrastructure"
  | "understanding"
  | "publishing"
  | "payment"
  | "library";

export interface Processor {
  /** What a person would recognise it as. */
  name: string;
  /** The hosts in this codebase that belong to it. Matched by the suite. */
  hosts: readonly string[];
  role: ProcessorRole;
  /** What actually leaves us, in the plainest words that are still true. */
  sends: { en: string; ar: string };
  /** Why, in one line. */
  because: { en: string; ar: string };
  /**
   * Whether this one runs on every render or only when somebody chooses it.
   *
   * The distinction is the whole difference between "your video is sent to
   * these companies" and "your video is sent to these companies if you connect
   * an account", and a policy that flattens the two is a policy that
   * overstates in one direction and understates in the other.
   */
  always: boolean;
}

export const PROCESSORS: readonly Processor[] = [
  {
    name: "Supabase",
    hosts: ["supabase.co", "supabase.com"],
    role: "infrastructure",
    sends: {
      en: "your email address, your sign-in, every video you upload, and everything the product makes from it",
      ar: "بريدك، وتسجيل دخولك، وكل فيديو ترفعه، وكل ما يصنعه المنتج منه",
    },
    because: {
      en: "it is the database and the file storage this product is built on",
      ar: "هي قاعدة البيانات والتخزين اللذان بُني عليهما هذا المنتج",
    },
    always: true,
  },
  {
    name: "Vercel",
    hosts: ["vercel.app", "vercel.com"],
    role: "infrastructure",
    sends: {
      en: "the ordinary details of a web request: your address, your browser, and which page you asked for",
      ar: "تفاصيل الطلب المعتادة: عنوانك، ومتصفّحك، وأي صفحة طلبت",
    },
    because: { en: "it serves the website and the API", ar: "تخدم الموقع والـAPI" },
    always: true,
  },
  {
    name: "Fly.io",
    hosts: ["fly.io", "fly.dev"],
    role: "infrastructure",
    sends: {
      en: "the video being edited, while it is being edited",
      ar: "الفيديو الجاري تحريره، أثناء تحريره",
    },
    because: {
      en: "the machine that actually cuts the video runs there",
      ar: "الآلة التي تقصّ الفيديو فعلًا تعمل هناك",
    },
    always: true,
  },
  {
    name: "Deepgram",
    hosts: ["api.deepgram.com"],
    role: "understanding",
    sends: { en: "the audio of your video", ar: "صوت الفيديو" },
    because: {
      en: "to turn speech into words with a timestamp on each one, which is what a caption and a silence cut are made of",
      ar: "لتحويل الكلام إلى كلمات بتوقيت لكل كلمة، وهو ما يُصنع منه الكابشن وقصّ الصمت",
    },
    always: false,
  },
  {
    name: "ElevenLabs",
    hosts: ["api.elevenlabs.io"],
    role: "understanding",
    sends: { en: "the audio of your video", ar: "صوت الفيديو" },
    because: {
      en: "a second transcription, read against the first, because a wrong word burned onto the screen is the plainest failure a caption has",
      ar: "تفريغ ثانٍ يُقارن بالأوّل، لأن كلمة خاطئة محروقة على الشاشة أوضح فشل في الكابشن",
    },
    always: false,
  },
  {
    name: "Google (Gemini)",
    hosts: ["generativelanguage.googleapis.com"],
    role: "understanding",
    sends: { en: "still frames from your video", ar: "إطارات ثابتة من الفيديو" },
    because: {
      en: "to see what is on screen (a face, a product, text) so the frame can follow it",
      ar: "لرؤية ما على الشاشة: وجه، منتج، نصّ، كي يتبعه الكادر",
    },
    always: false,
  },
  {
    name: "OpenAI",
    hosts: ["api.openai.com"],
    role: "understanding",
    sends: {
      en: "the sentence you type, and the list of file names in that project",
      ar: "الجملة التي تكتبها، وأسماء ملفّات ذلك المشروع",
    },
    because: {
      en: "to turn what you asked for into a list of edits. It is never sent your video",
      ar: "لتحويل ما طلبته إلى قائمة تعديلات. لا يُرسَل إليه الفيديو أبدًا",
    },
    always: false,
  },
  {
    name: "Freemius",
    hosts: ["freemius.com", "checkout.freemius.com"],
    role: "payment",
    sends: { en: "your email address and what you bought", ar: "بريدك وما اشتريته" },
    because: {
      en: "it is the merchant of record: it takes the payment, and your card details never reach us at all",
      ar: "هو التاجر المسجَّل: يأخذ الدفعة، وتفاصيل بطاقتك لا تصل إلينا إطلاقًا",
    },
    always: false,
  },
  {
    name: "Pexels",
    hosts: ["api.pexels.com", "www.pexels.com"],
    role: "library",
    sends: { en: "the words you search for", ar: "الكلمات التي تبحث بها" },
    because: {
      en: "to find stock footage. Nothing of yours is sent",
      ar: "للعثور على لقطات جاهزة. لا يُرسَل شيء من ملفّاتك",
    },
    always: false,
  },
  {
    name: "YouTube, Instagram, Facebook, TikTok, X and Snapchat",
    hosts: [
      "www.googleapis.com",
      "oauth2.googleapis.com",
      "accounts.google.com",
      "www.youtube.com",
      "graph.facebook.com",
      "www.facebook.com",
      "www.instagram.com",
      "open.tiktokapis.com",
      "www.tiktok.com",
      "api.twitter.com",
      "twitter.com",
      // X's own name for itself. The token exchange still answers on
      // `api.twitter.com` and the media upload and the post are on `api.x.com`,
      // so both are reached and both are named. A host the code talks to and
      // this list does not carry is a host the privacy page does not disclose,
      // which `tools/privacy-test.mjs` refuses.
      "api.x.com",
      "x.com",
      "accounts.snapchat.com",
      "adsapi.snapchat.com",
    ],
    role: "publishing",
    sends: {
      en: "the finished video and the caption you wrote, to the account you connected",
      ar: "الفيديو النهائي والكابشن الذي كتبته، إلى الحساب الذي ربطته",
    },
    because: {
      en: "you asked for it to be posted there. Nothing goes to a platform you have not connected",
      ar: "لأنك طلبت نشره هناك. لا شيء يذهب إلى منصّة لم تربطها",
    },
    always: false,
  },
];

/** Everything that receives something on an ordinary render, with no choices made. */
export function alwaysUsed(): Processor[] {
  return PROCESSORS.filter((p) => p.always);
}

/** Every host any of them is reached at — what the suite checks the code against. */
export function knownHosts(): string[] {
  return PROCESSORS.flatMap((p) => [...p.hosts]);
}
