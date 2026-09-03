/**
 * The account screen.
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
   * The account screen.
   *
   * The four things a person needs to be able to do to a service they pay for:
   * see what they are on, change how they sign in, take their data, and leave.
   */
export const ACCOUNT = {
  title: p("الحساب", "Account"),
  signedIn: p("مسجَّل الدخول", "Signed in"),

  planTitle: p("خطّتك", "Your plan"),
  planLead: p(
    "دقائق فيديو نهائي، لا عدد مقاطع. الرفع لا يستهلك منها شيئًا.",
    "Minutes of finished video, not videos. Uploading doesn't spend them.",
  ),
  planFailed: p("خطّتك واستهلاكك", "your plan and usage"),
  free: p("مجانًا", "Free"),
  perMonth: f<[number]>((price) => `$${price}/شهريًا`, (price) => `$${price}/month`),
  usage: f<[number, number]>(
    (used, included) => `${used} من ${included} دقيقة هذا الشهر`,
    (used, included) => `${used} of ${included} minutes this month`,
  ),
  maxUpload: f<[number]>(
    (minutes) => `حتى ${minutes} دقيقة في الرفعة الواحدة`,
    (minutes) => `up to ${minutes} minutes in a single upload`,
  ),
  watermark: p("‏ · التنفيذ يحمل علامة Editly", " · renders carry the Editly mark"),
  changePlan: p("غيّر الخطّة", "Change plan"),
  invoices: p("الفواتير والإلغاء", "Invoices and cancellation"),

  socialTitle: p("إلى أين يذهب تعديلك", "Where your edits go"),
  socialLead: p(
    "اربط الحسابات التي تنشر عليها، فيُجدوَل التعديل الجاهز من المشروع مباشرة، والكابشن يُكتب مرّة واحدة. أكثر من حساب لكل منصّة، لأن أغلب الناس عندهم أكثر من واحد.",
    "Connect the accounts you post to and a finished edit can be scheduled straight from the project, with the caption written once. Several accounts per platform, because most people run more than one.",
  ),
  socialReading: p("نقرأ اتصالاتك…", "Reading your connections…"),

  scheduledTitle: p("المنشورات المجدولة", "Scheduled posts"),
  scheduledLead: p(
    "كل ما هو في الطريق وكل ما خرج. ويمكنك سحب أي منشور ما دام لم يخرج بعد.",
    "Everything queued to go out, and everything that has. You can call one back until it leaves.",
  ),

  signinTitle: p("الدخول", "Signing in"),
  signinLead: p("غيّر بريد هذا الحساب أو كلمة مروره.", "Change the address or the password on this account."),
  newEmail: p("بريد جديد", "New email address"),
  sendConfirmation: p("أرسل التأكيد", "Send confirmation"),
  newPassword: p("كلمة مرور جديدة", "New password"),
  passwordHint: p("8 أحرف على الأقل", "At least 8 characters"),
  changePassword: p("غيّر كلمة المرور", "Change password"),

  emailFailed: p("تعذّر تغيير بريدك", "Could not change your email"),
  checkBothInboxes: p("افتح البريدين", "Check both inboxes"),
  // Both addresses, because Supabase asks the old one to approve the change
  // and the new one to prove it exists.
  checkBothDetail: f<[string]>(
    (next) => `أرسلنا تأكيدًا إلى ${next} وإلى عنوانك الحالي. يسري التغيير بعد تأكيد الاثنين.`,
    (next) => `We've sent a confirmation to ${next} and to your current address. The change takes effect once both are confirmed.`,
  ),
  passwordTooShort: p("كلمة المرور قصيرة", "That password is too short"),
  passwordTooShortDetail: p(
    "ثمانية أحرف هي الحدّ الأدنى. الأطول أفضل من الأعقد.",
    "Eight characters is the minimum. Longer is better than complicated.",
  ),
  passwordFailed: p("تعذّر تغيير كلمة المرور", "Could not change your password"),
  passwordChanged: p("تغيّرت كلمة المرور", "Password changed"),
  passwordChangedDetail: p("ستستعمل الجديدة في الدخول القادم.", "You'll use the new one next time you sign in."),

  dataTitle: p("بياناتك", "Your data"),
  dataLead: p(
    "كل ما يحتفظ به هذا المنتج عنك، في ملف واحد تأخذه معك. سجلّات لا فيديوهات: الفيديوهات مذكورة بأسمائها وتُنزَّل من مشاريعها.",
    "Everything this product holds about you, as one file you can keep. Rows, not videos: the videos are listed by name and downloaded from the project they belong to.",
  ),
  dataTokens: p(
    "مفاتيح الحسابات المربوطة ليست فيه. نسخة من المفتاح داخل ملف هي مفتاح عامل لذلك الحساب ما بقي الملف، فيظهر مكان كل واحد سطرٌ يشرح غيابه بدل أن يُحذف بصمت.",
    "Access tokens for connected accounts are not in it. A copy of one in a file is a working key to that account for as long as the file exists, so each appears with a note in its place rather than being left out.",
  ),
  downloadData: p("نزّل بياناتي", "Download my data"),
  puttingTogether: p("نجمعها…", "Putting it together…"),
  exportFailed: p("تعذّر تجهيز الملف", "Could not put that together"),
  exportFailedDetail: p("حاول بعد دقائق.", "Please try again in a few minutes."),
  exportOffline: p("تحقّق من اتصالك وحاول مرّة أخرى.", "Check your connection and try again."),

  deleteTitle: p("احذف هذا الحساب", "Delete this account"),
  deleteLead: p(
    "كل مشروع وكل رفع وكل تنفيذ، يُزال نهائيًّا. لا رجعة، ولا نسخة محفوظة.",
    "Every project, every upload and every render, removed for good. This cannot be undone and there is no copy kept.",
  ),
  deleteBillingLead: p("إن كنت على خطّة مدفوعة فألغِها أولًا من ", "If you pay for a plan, cancel it first at "),
  deleteBillingLink: p("صفحة الفوترة", "your billing page"),
  deleteBillingTail: p(
    "‏. الحذف هنا يزيل فيديوهاتك، ولا يوقف اشتراكًا تفاصيل بطاقته عند جهة أخرى.",
    ". Deleting here removes your videos; it does not stop a subscription somebody else is holding the card details for.",
  ),
  /*
    The typed confirmation, and the one string on this screen whose Arabic is
    not only a translation but a second accepted answer. What a person types
    has to be what the label in front of them says, and the label is in their
    language; the English is still accepted, because somebody who switches
    language halfway through typing should not be trapped in a form.
  */
  deleteConfirmPhrase: p("احذف حسابي", "delete my account"),
  deleteConfirmLead: p("اكتب ", "Type "),
  deleteConfirmTail: p(" للتأكيد", " to confirm"),
  deleteButton: p("احذف حسابي", "Delete my account"),
  deleting: p("نحذف كل شيء…", "Deleting everything…"),
  deleteRefused: p("لم يُحذف شيء", "Nothing was deleted"),
  deleteRefusedDetail: p(
    "حدث خطأ عندنا. حسابك كما هو.",
    "Something went wrong on our side. Your account is untouched.",
  ),
  deleteOffline: p("تعذّر الوصول إلى الخادم. حسابك كما هو.", "We couldn't reach the server. Your account is untouched."),
  deleted: p("انتهى حسابك", "Your account is gone"),
  deletedDetail: p(
    "أُزيل كل ما رفعته. شكرًا لتجربتك المنتج.",
    "Everything you uploaded has been removed. Thanks for trying it.",
  ),
} as const;
