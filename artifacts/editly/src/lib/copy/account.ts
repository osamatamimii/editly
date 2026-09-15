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
    "دقايق فيديو جاهز، مش عدد مقاطع. والرفع ما بياكل منها شي.",
    "Minutes of finished video, not videos. Uploading doesn't spend them.",
  ),
  planFailed: p("خطّتك واستهلاكك", "your plan and usage"),
  free: p("مجانًا", "Free"),
  perMonth: f<[number]>((price) => `$${price}/شهريًا`, (price) => `$${price}/month`),
  usage: f<[number, number]>(
    (used, included) => `${used} من ${included} دقيقة هالشهر`,
    (used, included) => `${used} of ${included} minutes this month`,
  ),
  maxUpload: f<[number]>(
    (minutes) => `لحدّ ${minutes} دقيقة بالرفعة الوحدة`,
    (minutes) => `up to ${minutes} minutes in a single upload`,
  ),
  watermark: p("‏ · التنفيذ بيحمل علامة Editly", " · renders carry the Editly mark"),
  changePlan: p("غيّر الخطّة", "Change plan"),
  invoices: p("الفواتير والإلغاء", "Invoices and cancellation"),

  /*
    The code, and the one line that says what a granted plan is.

    A person on a promo is on a real plan with a real end date, and the date is
    the part they are owed: a plan that stops without warning reads as the
    product taking something back. So it is said on the card they already look
    at, beside the plan's name, and it is said only when there is a date — every
    paying customer sees none of this.
  */
  promoTitle: p("عندك كود؟", "Have a code?"),
  promoLead: p(
    "الكود بيفتح الخطّة لمدّة، بلا دفع وبلا بطاقة.",
    "A code opens a plan for a while. No payment, no card.",
  ),
  promoPlaceholder: p("اكتب الكود", "Enter your code"),
  promoRedeem: p("فعّل الكود", "Redeem"),
  promoWorking: p("عم نتأكّد…", "Checking…"),
  promoDone: p("فتحت الخطّة", "Your plan is open"),
  promoDoneDetail: f<[string, string]>(
    (plan, until) => `صرت على ${plan} لحدّ ${until}.`,
    (plan, until) => `You're on ${plan} until ${until}.`,
  ),
  promoUntil: f<[string]>((until) => `ممنوحة لحدّ ${until}`, (until) => `Given, until ${until}`),
  promoFailed: p("الكود ما اشتغل", "That code did not work"),
  /*
    One sentence per way a code can be refused, written from the reader's side.

    The server answers with a key rather than a sentence for exactly this: the
    reasons are not translations of each other. "Somebody already used this" and
    "you already used this" send a person to two different places, and a single
    "invalid code" would send them to neither.
  */
  promoUnknown: p("ما لقينا هالكود. تأكّد من حروفه.", "We don't know that code. Check the letters."),
  promoRevoked: p("هالكود انسحب.", "That code has been withdrawn."),
  promoExpired: p("خلص وقت هالكود.", "That code has passed its date."),
  promoUsedUp: p("هالكود انستعمل كلّه.", "That code has already been used."),
  promoAlreadyUsed: p("هالحساب استعمل هالكود من قبل.", "This account has already used that code."),
  promoPaidAccount: p(
    "عندك اشتراك مدفوع، والكود ما بينضاف عليه ولا بينقّص اللي بتدفعه.",
    "You have a paid subscription. A code cannot be added to one, and it would not reduce what you are charged.",
  ),
  promoNotAnUpgrade: p(
    "خطّتك الحالية مش أصغر من اللي بيعطيه هالكود.",
    "Your plan is not smaller than what that code gives.",
  ),

  socialTitle: p("إلى أين يذهب تعديلك", "Where your edits go"),
  socialLead: p(
    "اربط الحسابات اللي بتنشر عليها، وبيتجدول التعديل الجاهز من المشروع رأسًا، والكابشن بينكتب مرّة وحدة. أكتر من حساب لكل منصّة، لأن أغلب الناس عندهم أكتر من واحد.",
    "Connect the accounts you post to and a finished edit can be scheduled straight from the project, with the caption written once. Several accounts per platform, because most people run more than one.",
  ),
  socialReading: p("عم نقرا اتصالاتك…", "Reading your connections…"),

  scheduledTitle: p("المنشورات المجدولة", "Scheduled posts"),
  scheduledLead: p(
    "كل اللي بالطريق وكل اللي خرج. وفيك تسحب أي منشور ما دام ما طلع لسا.",
    "Everything queued to go out, and everything that has. You can call one back until it leaves.",
  ),

  signinTitle: p("الدخول", "Signing in"),
  signinLead: p("غيّر بريد هالحساب أو كلمة مروره.", "Change the address or the password on this account."),
  newEmail: p("بريد جديد", "New email address"),
  sendConfirmation: p("ابعت التأكيد", "Send confirmation"),
  newPassword: p("كلمة مرور جديدة", "New password"),
  passwordHint: p("8 أحرف على الأقل", "At least 8 characters"),
  changePassword: p("غيّر كلمة المرور", "Change password"),

  emailFailed: p("ما قدرنا نغيّر بريدك", "Could not change your email"),
  checkBothInboxes: p("افتح البريدين", "Check both inboxes"),
  // Both addresses, because Supabase asks the old one to approve the change
  // and the new one to prove it exists.
  checkBothDetail: f<[string]>(
    (next) => `بعتنا تأكيد لـ${next} ولعنوانك الحالي. التغيير بيصير بعد ما تأكّد الاتنين.`,
    (next) => `We've sent a confirmation to ${next} and to your current address. The change takes effect once both are confirmed.`,
  ),
  passwordTooShort: p("كلمة المرور قصيرة", "That password is too short"),
  passwordTooShortDetail: p(
    "تمن حروف هي الحدّ الأدنى. الأطول أحسن من الأعقد.",
    "Eight characters is the minimum. Longer is better than complicated.",
  ),
  passwordFailed: p("ما قدرنا نغيّر كلمة المرور", "Could not change your password"),
  passwordChanged: p("تغيّرت كلمة المرور", "Password changed"),
  passwordChangedDetail: p("رح تستعمل الجديدة بالدخول الجاي.", "You'll use the new one next time you sign in."),

  dataTitle: p("بياناتك", "Your data"),
  dataLead: p(
    "كل اللي بيحتفظ فيه هالمنتج عنك، بملفّ واحد بتاخده معك. سجلّات مش فيديوهات: الفيديوهات مذكورة بأسمائها وبتنزل من مشاريعها.",
    "Everything this product holds about you, as one file you can keep. Rows, not videos: the videos are listed by name and downloaded from the project they belong to.",
  ),
  dataTokens: p(
    "مفاتيح الحسابات المربوطة مش فيه. نسخة من المفتاح جوّا ملفّ بتضلّ مفتاح شغّال لهداك الحساب ما دام الملفّ موجود، فبيطلع مكان كل واحد سطر بيشرح غيابه بدل ما ينشال بالسكوت.",
    "Access tokens for connected accounts are not in it. A copy of one in a file is a working key to that account for as long as the file exists, so each appears with a note in its place rather than being left out.",
  ),
  downloadData: p("نزّل بياناتي", "Download my data"),
  puttingTogether: p("عم نجمّعها…", "Putting it together…"),
  exportFailed: p("ما قدرنا نجهّز الملفّ", "Could not put that together"),
  exportFailedDetail: p("جرّب بعد شوي.", "Please try again in a few minutes."),
  exportOffline: p("تأكّد من اتصالك وجرّب مرّة تانية.", "Check your connection and try again."),

  deleteTitle: p("احذف هالحساب", "Delete this account"),
  deleteLead: p(
    "كل مشروع وكل رفع وكل تنفيذ، بينشال نهائيًّا. ما في رجعة، ولا نسخة محفوظة.",
    "Every project, every upload and every render, removed for good. This cannot be undone and there is no copy kept.",
  ),
  deleteBillingLead: p("إذا كنت على خطّة مدفوعة ألغيها أوّل من ", "If you pay for a plan, cancel it first at "),
  deleteBillingLink: p("صفحة الفوترة", "your billing page"),
  deleteBillingTail: p(
    "‏. الحذف هون بيشيل فيديوهاتك، وما بيوقّف اشتراك تفاصيل بطاقته عند جهة تانية.",
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
  deleting: p("عم نحذف كل شي…", "Deleting everything…"),
  deleteRefused: p("ما انحذف شي", "Nothing was deleted"),
  deleteRefusedDetail: p(
    "صار خطأ عنّا. حسابك متل ما هو.",
    "Something went wrong on our side. Your account is untouched.",
  ),
  deleteOffline: p("ما قدرنا نوصل للخادم. حسابك متل ما هو.", "We couldn't reach the server. Your account is untouched."),
  deleted: p("انتهى حسابك", "Your account is gone"),
  deletedDetail: p(
    "شلنا كل اللي رفعته. شكرًا إنك جرّبت المنتج.",
    "Everything you uploaded has been removed. Thanks for trying it.",
  ),
} as const;
