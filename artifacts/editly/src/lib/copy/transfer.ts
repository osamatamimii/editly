/**
 * What the two modules with no React above them say when they throw: an
 * upload that failed, a sign-in that was refused, a checkout that is off.
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
   * The sentences that come out of the two modules with no React above them.
   *
   * `video-storage.ts` and `oauth.ts` are plain modules: they throw, and a
   * screen catches and shows what they said. They cannot hold a hook, so they
   * resolve against `storedLanguage()` like the crash screen does. That is why
   * these are grouped rather than filed under the screen they appear on: the
   * same upload error can surface in the editor, the dashboard, the library
   * and the stock sheet.
   */
export const TRANSFER = {
  couldNotReach: p(
    "تعذّر الوصول إلى Editly لبدء هذا الرفع. تحقّق من اتصالك وحاول مرّة أخرى.",
    "We could not reach Editly to start this upload. Check your connection and try again.",
  ),
  couldNotStart: f<[number]>(
    (status) => `تعذّر بدء هذا الرفع (${status}).`,
    (status) => `This upload could not be started (${status}).`,
  ),
  failed: f<[number]>(
    (status) => `فشل الرفع (${status})`,
    (status) => `Upload failed (${status})`,
  ),
  tooLarge: f<[string]>(
    (size) => `رفض التخزين هذا الملف لأنه كبير: ${size}.`,
    (size) => `Storage refused this file as too large at ${size}.`,
  ),
  networkError: p("خطأ في الشبكة أثناء الرفع.", "Network error during upload."),
  /*
    The same browser event, and a different thing entirely.

    `xhr.onerror` fires with nothing readable in it whether the connection
    dropped mid-transfer or the browser refused to make the request at all —
    and the second is what a storage bucket with no CORS policy for this site
    looks like from in here. The two are told apart by a fact the browser will
    give us: whether any byte was ever reported as sent. Zero bytes moved in a
    request that was going to send a gigabyte is not a network that failed, it
    is a request that never left.

    Worth its own sentence because the advice is opposite. "Try again" is right
    for a tunnel and useless for a bucket that will refuse every attempt for
    the rest of the day.
  */
  neverLeft: p(
    "لم يقبل التخزين الاتصال من هذا الموقع، فلم تُرسل أي بايت. هذا إعداد في الدلو (سياسة CORS) لا مشكلة في ملفك ولا في شبكتك.",
    "Storage would not accept a connection from this site, so no bytes were sent. That is a setting on the bucket (its CORS policy) rather than anything about your file or your connection.",
  ),
  cancelled: p("أُلغي الرفع.", "Upload cancelled."),
  noDestination: p("لم يعطنا التخزين مكانًا للرفع إليه.", "Storage did not return somewhere to upload to."),
  /*
    The one failure a person cannot act on and an operator can.

    Every part of the file arrived, and the browser could not read the receipt
    the provider returned for it — which happens for exactly one reason: the
    bucket does not expose `etag` to this origin in its CORS policy. Saying
    "upload failed" there would send somebody to try a smaller file all
    afternoon on a bucket that is accepting every byte they send.
  */
  noReceipt: p(
    "وصلت كل أجزاء الملف، لكن التخزين لم يُعطِ المتصفّح إيصال كل جزء (ترويسة etag محجوبة عن هذا الموقع في إعداد CORS للدلو). الملف سليم والإعداد هو ما يحتاج تصحيحًا.",
    "Every part of the file arrived, and the browser could not read the receipt for them (the bucket's CORS policy does not expose the etag header to this site). Nothing is wrong with the file; the bucket's settings are what need a change.",
  ),
  partFailed: f<[number, number]>(
    (part, of) => `تعذّر رفع الجزء ${part} من ${of} بعد عدّة محاولات.`,
    (part, of) => `Part ${part} of ${of} could not be uploaded after several tries.`,
  ),
  couldNotAssemble: p(
    "وصلت كل الأجزاء ولم يستطع التخزين تجميعها. لم يضع شيء من ملفك؛ إعادة الرفع أسرع طريق.",
    "Every part arrived and storage could not assemble them. Nothing of your file was lost; starting again is the fastest way through.",
  ),
  referenceTooBig: f<[string, string]>(
    (size, ceiling) =>
      `هذا المرجع ${size}. نحن نقرأ أوّل دقيقتين منه فقط، فأبقِه دون ${ceiling}. مقطع قصير بالستايل الذي تريده يكفي.`,
    (size, ceiling) =>
      `That reference is ${size}. We only read the first couple of minutes of one, so keep it under ${ceiling}. A short clip in the style you want is plenty.`,
  ),
  notMedia: f<[string]>(
    (name) => `نستطيع التعامل مع الفيديو والصور والصوت. «${name}» ليس منها، فليس هناك ما نفعله به في تعديل.`,
    (name) => `We can use video, images and audio. "${name}" is none of those, so there is nothing we could do with it in an edit.`,
  ),
  assetTooBig: f<[string, string, string]>(
    (name, size, ceiling) => `«${name}» حجمه ${size}. أبقِ كل ملف إضافي دون ${ceiling}.`,
    (name, size, ceiling) => `"${name}" is ${size}. Keep each extra file under ${ceiling}.`,
  ),

  providerOff: f<[string]>(
    (name) => `الدخول عبر ${name} غير مفعّل في هذا المشروع بعد.`,
    (name) => `${name} sign-in is not switched on for this project yet.`,
  ),
  signInCancelled: p("أُلغي تسجيل الدخول.", "Sign-in was cancelled."),
  signInFailed: f<[string]>(
    (code) => `فشل تسجيل الدخول (${code}).`,
    (code) => `Sign-in failed (${code}).`,
  ),
} as const;

  /** Payment, which happens somewhere else. */
export const CHECKOUT = {
  notSwitchedOn: p("الدفع غير مفعّل في هذه النشرة بعد.", "Checkout is not switched on for this deployment yet."),
  couldNotStart: p("تعذّر بدء الدفع. حاول بعد لحظات.", "Could not start checkout. Try again in a moment."),
} as const;
