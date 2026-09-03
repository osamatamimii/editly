/**
 * The front door, and where a recovery link lands.
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
   * The front door.
   *
   * One screen and three forms, and the Arabic has to carry the same
   * distinction the English does: signing in, creating an account, and asking
   * for a link because the password is gone.
   */
export const LOGIN = {
  signature: p("توقّف عن المونتاج. ابدأ بالوصف.", "Stop editing. Start describing."),
  signinTitle: p("أهلًا بعودتك", "Welcome back"),
  signupTitle: p("أنشئ حسابك", "Create your account"),
  resetTitle: p("استعادة كلمة المرور", "Reset your password"),
  signinLead: p("ادخل لتكمل من حيث توقّفت.", "Sign in to pick up where you left off."),
  signupLead: p("ابدأ بتحويل التسجيل الخام إلى منشور.", "Start turning raw footage into viral clips."),
  resetLead: p(
    "اكتب البريد الذي سجّلت به، ونرسل لك رابطًا.",
    "Tell us the address you signed up with and we will send a link.",
  ),
  withGoogle: p("تابع بحساب Google", "Continue with Google"),
  withApple: p("تابع بحساب Apple", "Continue with Apple"),
  orWithEmail: p("أو بالبريد", "or with email"),
  email: p("البريد الإلكتروني", "Email"),
  password: p("كلمة المرور", "Password"),
  forgot: p("نسيتها؟", "Forgot it?"),
  passwordHintNew: p("6 أحرف على الأقل", "At least 6 characters"),
  passwordHint: p("كلمة المرور", "Your password"),
  submitSignin: p("ادخل", "Sign in"),
  submitSignup: p("أنشئ الحساب", "Create account"),
  submitReset: p("أرسل الرابط", "Send the link"),
  switchFromSignin: p("جديد على Editly؟", "New to Editly?"),
  switchFromSignup: p("لديك حساب؟", "Already have an account?"),
  switchFromReset: p("تذكّرتها؟", "Remembered it?"),
  switchToSignup: p("أنشئ حسابًا", "Create an account"),
  switchToSignin: p("ادخل", "Sign in"),
  /*
    The same sentence whether or not that address has an account. Saying "no
    account with that email" turns this box into a way to test who uses
    Editly, one address at a time.
  */
  resetSent: p(
    "إن كان لهذا العنوان حساب، فالرابط في طريقه إليه. صلاحيته ساعة.",
    "If that address has an account, a link is on its way. It lasts an hour.",
  ),
  confirmEmail: p(
    "افتح بريدك وأكّد العنوان، ثم ادخل.",
    "Check your inbox to confirm your email, then sign in.",
  ),
  providerOff: f<[string]>(
    (name) => `الدخول عبر ${name} غير مفعّل بعد. استعمل بريدك الآن.`,
    (name) => `${name} sign-in isn't switched on yet. Use your email for now.`,
  ),
  couldNotStart: p("تعذّر بدء الدخول. حاول مرّة أخرى.", "Could not start sign-in. Please try again."),
  somethingWrong: p("حدث خطأ. حاول مرّة أخرى.", "Something went wrong. Please try again."),
  /*
    The two documents, on the screen where the account is actually made. This
    line is a legal requirement rather than copy, and it is the one place the
    legal pages are named from a translated screen: the link text is
    translated, the pages themselves are not, and `/terms` and `/privacy`
    still declare English until a lawyer has written the Arabic.
  */
  agreeLead: p("بإنشاء حساب فأنت توافق على ", "By creating an account you agree to our "),
  agreeTerms: p("الشروط", "Terms"),
  agreeAnd: p(" و", " and "),
  agreePrivacy: p("سياسة الخصوصية", "Privacy Policy"),
  agreeTail: p("‏. Editly لمن أعمارهم 16 فأكثر.", ". Editly is for people aged 16 and over."),
} as const;

  /** Where a recovery link lands. */
export const RESET = {
  checking: p("نتحقّق من رابطك…", "Checking your link…"),
  expiredTitle: p("انتهت صلاحية هذا الرابط", "This link has expired"),
  expiredLead: p(
    "روابط الاستعادة تدوم ساعة وتُستعمل مرّة واحدة. اطلب رابطًا جديدًا ويصلك خلال دقيقة.",
    "Reset links last an hour and can only be used once. Ask for a new one and it will arrive in a minute.",
  ),
  sendAnother: p("أرسل لي رابطًا آخر", "Send me another"),
  doneTitle: p("تمّ", "That's set"),
  doneLead: p("ننقلك إلى مشاريعك…", "Taking you to your projects…"),
  chooseTitle: p("اختر كلمة مرور جديدة", "Choose a new password"),
  chooseLead: p(
    "أنت مسجَّل الدخول على هذا الجهاز بالفعل. هذه تضبط كلمة المرور للمرّة القادمة.",
    "You are signed in on this device already. This sets the password for next time.",
  ),
  newPassword: p("كلمة مرور جديدة", "New password"),
  minChars: f<[number]>((n) => `${n} أحرف على الأقل`, (n) => `At least ${n} characters`),
  andAgain: p("ومرّة أخرى", "And again"),
  sameOne: p("الكلمة نفسها", "The same one"),
  notTheSame: p("الكلمتان غير متطابقتين.", "Those two passwords are not the same."),
  couldNotSet: p("تعذّر ضبط كلمة المرور. حاول مرّة أخرى.", "Could not set that password. Please try again."),
  setIt: p("اضبط كلمة مروري", "Set my password"),
} as const;
