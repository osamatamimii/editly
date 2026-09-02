/**
 * The screen an unsubscribe link lands on.
 *
 * It is a screen and not a redirect for one reason, and it is the reason the
 * API's `GET` does not unsubscribe either: a link in an email is fetched by
 * things that are not the person. Corporate mail scanners, link previewers and
 * antivirus proxies follow every URL in every message before it reaches an
 * inbox. A link that unsubscribed on being followed would quietly unsubscribe
 * people who never opened the letter, and nothing would report it — the mail
 * just stops, and they conclude the product forgot them.
 *
 * So this reads the token, says what the current setting is, and changes it on
 * a press.
 *
 * It is in both languages, and it is the third screen in the product that is.
 * That is not a nicety here: somebody who has only ever read this product in
 * Arabic should not meet English at the one moment they are trying to leave.
 */
import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { Loader2, MailX, MailCheck } from "lucide-react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useLanguage } from "@/lib/language";
import { phrase } from "@/lib/landing-copy";

const COPY = {
  checking: phrase("نتحقّق من الرابط…", "Checking your link…"),
  subscribedTitle: phrase("رسائل الأخبار تصلك حاليًّا", "You are getting our updates"),
  subscribedBody: phrase(
    "اضغط الزر ونوقفها. رسائل الحساب ستبقى تصلك: الفيديو الجاهز، والدفعة التي لم تنجح، والحدّ الذي بلغته.",
    "Press the button and they stop. Account messages still reach you: the video that is ready, the payment that did not go through, the limit you reached.",
  ),
  stop: phrase("أوقف رسائل الأخبار", "Stop the updates"),
  stopping: phrase("نوقفها…", "Stopping…"),
  goneTitle: phrase("توقّفت", "That's done"),
  goneBody: phrase(
    "لن تصلك رسائل أخبار بعد الآن. رسائل الحساب ستبقى تصلك، لأنها عن أشياء طلبتها.",
    "No more updates. Account messages still reach you, because they are about things you asked for.",
  ),
  undo: phrase("أعِدها", "Actually, keep them"),
  undoing: phrase("نعيدها…", "Turning them back on…"),
  unknownTitle: phrase("هذا الرابط لم يعد يعمل", "This link no longer works"),
  /*
    Ours, not the server's.

    The API answers with a sentence, and it has to: something has to be said to
    a `curl`, and to a mail client following the one-click URL. But that
    sentence is written once, in English, by a route with no session and no way
    to know who is reading — and printing it here put an English line under an
    Arabic heading on the one screen somebody is using to leave.
  */
  unknownBody: phrase(
    "قد يكون من رسالة قديمة، أو قُطع في برنامج البريد. الرابط في آخر رسالة وصلتك سيعمل.",
    "It may be from an old message, or it may have been cut short by an email client. The link in your most recent email will work.",
  ),
  failedTitle: phrase("تعذّر التحقّق", "We could not check that"),
  failedBody: phrase(
    "لم نستطع قراءة الرابط الآن، ولم يتغيّر شيء. جرّب بعد دقيقة.",
    "We could not read that link just now, and nothing was changed. Try again in a minute.",
  ),
} as const;

type State =
  | { kind: "checking" }
  | { kind: "known"; subscribed: boolean }
  /** `gone` is a token we do not have; `failed` is one we could not look up. */
  | { kind: "gone" }
  | { kind: "failed" };

export default function Unsubscribe() {
  const { token } = useParams<{ token: string }>();
  const { t } = useLanguage();
  const [state, setState] = useState<State>({ kind: "checking" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/mail/unsubscribe/${token}`)
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!live) return;
        if (body?.known) setState({ kind: "known", subscribed: Boolean(body.subscribed) });
        // 404 is a token we do not have; anything else is a lookup that failed,
        // and the two need different sentences: one is final, one is "try in a
        // minute".
        else setState({ kind: response.status === 404 ? "gone" : "failed" });
      })
      .catch(() => {
        if (live) setState({ kind: "failed" });
      });
    return () => {
      live = false;
    };
  }, [token]);

  const set = async (resubscribe: boolean) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/mail/unsubscribe/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resubscribe }),
      });
      const body = await response.json().catch(() => null);
      if (body?.known) setState({ kind: "known", subscribed: Boolean(body.subscribed) });
      else setState({ kind: response.status === 404 ? "gone" : "failed" });
    } catch {
      setState({ kind: "failed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center px-6 py-12">
      <div className="flex items-center gap-2.5 mb-8">
        <Logo className="w-8 h-8 text-brand-mark" />
        <span className="font-bold text-xl tracking-tight">Editly</span>
      </div>

      <Card className="glass-panel border-hairline w-full max-w-md">
        <CardContent className="pt-8 pb-8 text-center flex flex-col items-center gap-4">
          {state.kind === "checking" && (
            <div className="flex flex-col items-center gap-3 py-6" data-testid="state-unsubscribe-checking">
              <Loader2 className="w-5 h-5 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">{t(COPY.checking)}</p>
            </div>
          )}

          {state.kind === "gone" && (
            <div data-testid="state-unsubscribe-unknown">
              <h1 className="text-2xl font-bold mb-2">{t(COPY.unknownTitle)}</h1>
              <p className="text-sm text-muted-foreground">{t(COPY.unknownBody)}</p>
            </div>
          )}

          {state.kind === "failed" && (
            <div data-testid="state-unsubscribe-failed">
              <h1 className="text-2xl font-bold mb-2">{t(COPY.failedTitle)}</h1>
              <p className="text-sm text-muted-foreground">{t(COPY.failedBody)}</p>
            </div>
          )}

          {state.kind === "known" && state.subscribed && (
            <div data-testid="state-unsubscribe-subscribed" className="flex flex-col items-center gap-4">
              <MailCheck className="w-8 h-8 text-primary" />
              <h1 className="text-2xl font-bold">{t(COPY.subscribedTitle)}</h1>
              <p className="text-sm text-muted-foreground">{t(COPY.subscribedBody)}</p>
              <Button
                className="w-full h-12 rounded-xl btn-gradient-cta text-white font-semibold"
                disabled={busy}
                onClick={() => set(false)}
                data-testid="button-unsubscribe"
              >
                {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {busy ? t(COPY.stopping) : t(COPY.stop)}
              </Button>
            </div>
          )}

          {state.kind === "known" && !state.subscribed && (
            <div data-testid="state-unsubscribe-done" className="flex flex-col items-center gap-4">
              <MailX className="w-8 h-8 text-muted-foreground" />
              <h1 className="text-2xl font-bold">{t(COPY.goneTitle)}</h1>
              <p className="text-sm text-muted-foreground">{t(COPY.goneBody)}</p>
              {/* The way back, because an accidental press is the commonest
                  reason somebody is on this screen at all. */}
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => set(true)}
                data-testid="button-resubscribe"
              >
                {busy && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {busy ? t(COPY.undoing) : t(COPY.undo)}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
