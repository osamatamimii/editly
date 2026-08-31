/**
 * What happens to somebody's video, said in the words of what the code does.
 *
 * Required before any of this can go further: Google, Meta and TikTok all
 * refuse to review an app without one, and Freemius has been selling without
 * one for weeks.
 *
 * ## It is rendered from a list, not written out
 *
 * The companies below come from `lib/api-zod/src/processors.ts`, which
 * `tools/privacy-test.mjs` checks against every host this codebase sends a
 * request to. Adding a provider without adding it to that list turns CI red.
 *
 * That is the whole design. A privacy policy is a promise, and the way a
 * promise like this stops being true is never a rewrite — it is somebody
 * wiring up a new transcription provider next month and shipping it, while the
 * page still names the old three. Nothing fails; the customer's audio is at a
 * company they were never told about.
 *
 * ## The details that are missing are shown as missing
 *
 * The company registration lines are things only Osama can supply, and there
 * were three ways to handle that. Shipping a bracketed placeholder where the
 * company name belongs teaches a reader
 * that nobody ever read the document, and they stop trusting the parts that
 * *are* true. Waiting leaves the useful half — eleven companies and what each
 * receives — unread while every platform review stays blocked on a postal
 * address. So the gaps are drawn as gaps: see `PendingDetail`, and the notice
 * at the top that goes with them.
 */
import { PROCESSORS } from "@workspace/api-zod/processors";
import { Link } from "wouter";
import { BackButton } from "@/components/back-button";
import { PendingDetail, PendingNotice } from "@/components/pending-detail";

const UPDATED = "31 August 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

export default function Privacy() {
  const always = PROCESSORS.filter((p) => p.always);
  const chosen = PROCESSORS.filter((p) => !p.always);

  return (
    <div className="min-h-screen px-4 sm:px-6 py-6 sm:py-10 max-w-3xl mx-auto flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <BackButton fallback="/" />
        <h1 className="text-2xl sm:text-3xl font-bold">Privacy</h1>
        <p className="text-sm text-muted-foreground">
          What Editly does with your videos and your account. Last updated {UPDATED}.
        </p>
      </div>

      <PendingNotice />

      <Section title="The short version">
        <p>
          Your videos are yours. We store them so the product can edit them, we send parts of
          them to the companies listed below so it can understand them, and we do not sell
          them, train models on them, or show them to anyone.
        </p>
        <p>
          Nothing is posted anywhere unless you connect an account and schedule it yourself.
        </p>
      </Section>

      <Section title="What we hold">
        <p>
          <strong className="text-foreground">Your account.</strong> An email address, and
          whether you signed in with a password or with Google or Apple. We never see your
          password: sign-in is handled by Supabase Auth.
        </p>
        <p>
          <strong className="text-foreground">Your files.</strong> Every video you upload,
          every file you add to a project, every font you upload, and everything the product
          renders from them. They sit in private storage where each account can only reach its
          own folder, and every playback link is signed and short-lived.
        </p>
        <p>
          <strong className="text-foreground">What you typed.</strong> The sentences you send
          in a project, and the plans they produced.
        </p>
        <p>
          <strong className="text-foreground">Your connections.</strong> If you connect a
          social account, we store the token that lets us post to it, and the handle and
          picture of the account so you can tell which one it is.
        </p>
        <p>
          <strong className="text-foreground">Nothing else.</strong> There is no analytics
          script on this product, no advertising pixel, and no third-party cookie. The only
          cookie we set is a short-lived one during the few seconds of connecting a social
          account.
        </p>
      </Section>

      <Section title="Who else receives something">
        <p>
          These three receive something on every edit, because they are what the product runs
          on:
        </p>
        <ul className="flex flex-col gap-2 pl-1">
          {always.map((p) => (
            <li key={p.name} className="flex flex-col">
              <span className="text-foreground font-medium">{p.name}</span>
              <span>
                Receives {p.sends.en}, {p.because.en}.
              </span>
            </li>
          ))}
        </ul>
        <p className="pt-2">
          And these receive something only when you ask for the thing that needs them:
        </p>
        <ul className="flex flex-col gap-2 pl-1">
          {chosen.map((p) => (
            <li key={p.name} className="flex flex-col">
              <span className="text-foreground font-medium">{p.name}</span>
              <span>
                Receives {p.sends.en}, {p.because.en}.
              </span>
            </li>
          ))}
        </ul>
        <p className="pt-2">
          {/*
            Said plainly because it is the question people actually have, and
            because the answer is one we can give: we do not have a licence to
            anybody's video beyond running the product on it.
          */}
          None of them is permitted to use your video for anything except doing the piece of
          work we asked them for. We do not use your videos to train anything, and we do not
          licence them to anyone.
        </p>
      </Section>

      <Section title="Payments">
        <p>
          Freemius is the merchant of record for Editly. When you buy a plan, the payment is
          taken by them, and your card details never reach us: we are told an email address
          and which plan it bought.
        </p>
      </Section>

      <Section title="How long anything is kept">
        <p>
          Your files stay until you delete them. Deleting a project deletes the files under it;
          deleting your account deletes the account, its projects, and its files.
        </p>
        <p>
          One thing survives an account deletion on purpose: the record of payments, because a
          business is required to keep its books. It holds what was paid and when, not your
          videos.
        </p>
      </Section>

      <Section title="What you can ask for">
        <p>
          A copy of what we hold about you, a correction, or a deletion. Deleting your account
          from the account screen does the last one immediately and completely; write to us for
          the others.
        </p>
        <p>
          If you are in the EU or the UK, the lawful basis for holding your files is performing
          the contract you signed up for. You asked us to edit a video, and we cannot do that
          without the video.
        </p>
      </Section>

      <Section title="Children">
        <p>
          Editly is not for people under 16, and we do not knowingly hold anything belonging to
          one.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          If this page changes in a way that affects what happens to your files, we will say so
          by email to the address on your account rather than only editing this page.
        </p>
      </Section>

      <Section title="Who we are">
        <p>
          Editly is operated by <PendingDetail what="Registered company name" />,{" "}
          <PendingDetail what="Registered address" />.
        </p>
        <p>
          Questions about anything on this page: <PendingDetail what="Privacy contact" />.
        </p>
      </Section>

      <p className="text-xs text-muted-foreground pt-4 border-t border-hairline">
        See also the <Link href="/terms" className="text-primary hover:underline">terms of use</Link>.
      </p>
    </div>
  );
}
