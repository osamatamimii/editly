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
import { PROCESSORS, DATA_REGION, RETENTION, ACCOUNT_MIN_AGE } from "@workspace/api-zod/processors";
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
        <p>
          {/*
            Said because the paragraph above it invites the wrong conclusion.

            "No analytics, no pixel, no third-party cookie" is true and reads as
            "nothing leaves your browser except to us" — and the page loads its
            typefaces from Google and Fontshare, which means both see the
            address of everybody who opens it. Self-hosting the files would end
            it outright and is the better fix; until then the honest thing is to
            say it rather than let the sentence above do the work.
          */}
          <strong className="text-foreground">One exception, and it is the fonts.</strong> The
          typefaces this product is set in are fetched from Google Fonts and Fontshare when a
          page loads, so both of them see the address your browser connects from and which
          browser it is. They receive nothing else: no account, no video, no name. We would
          rather serve the files ourselves, and that is the fix we intend.
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
          <strong className="text-foreground">Your videos stay until you delete them.</strong> The
          master of every upload and every edit, for as long as the project exists. Deleting a
          project deletes the files under it; deleting your account deletes the account, its
          projects, and its files.
        </p>
        <p>
          {/*
            The two windows the sweep actually has.

            The page said "your files stay until you delete them" and stopped
            there, which was true only because the sweep ships in `dry` mode and
            removes nothing. It is one environment variable away from being
            false, and a policy that becomes a lie when a setting changes is a
            policy nobody can rely on. `privacy-test` compares these numbers
            against `DEFAULT_RETENTION` in the worker, so they cannot drift.
          */}
          Two copies beside them are not videos and do age out. A browser-playable mirror we
          write next to each master goes {RETENTION.previewDays} days after a project was last
          opened; losing it costs nothing you can see, because the player falls back to the
          master on its own. And a video you uploaded and never edited goes after{" "}
          {RETENTION.unusedSourceDays} days. Poster frames are kept: they are what your
          dashboard is made of.
        </p>
        <p>
          One thing survives an account deletion on purpose: the record of payments, because a
          business is required to keep its books. It holds what was paid and when, not your
          videos.
        </p>
      </Section>

      <Section title="Where your files are">
        <p>
          Your videos are stored and edited in {DATA_REGION.where.en}. The database, the file
          storage and the machine that runs the edit are all there, which is also why they are
          there: moving video across a continent on every render costs time nobody would
          understand from the outside.
        </p>
        <p>
          Some of the companies above are not. When a transcript is made, a scene is read or a
          plan is written by a model, that part of your video goes to a provider in the United
          States, and it goes only when the feature that needs it runs. The list above says which
          ones always receive something and which only do when you choose. The arrangement we hold
          with each of them for that transfer:{" "}
          <PendingDetail what="Transfer mechanism" />.
        </p>
      </Section>

      <Section title="What you can ask for">
        <p>
          A copy of what we hold about you, a correction, or a deletion. The account screen does
          two of those itself: <strong>Download my data</strong> gives you every row we hold in
          one file, and deleting your account does the last one immediately and completely. Write
          to us for a correction.
        </p>
        <p>
          The export leaves out the access tokens for accounts you have connected, and says so
          where each one would have been. A copy of one in a file is a working key to that account
          for as long as the file exists, and handing you one would be a worse answer than the
          gap.
        </p>
        <p>
          If you are in the EU or the UK, the lawful basis for holding your files is performing
          the contract you signed up for. You asked us to edit a video, and we cannot do that
          without the video.
        </p>
      </Section>

      <Section title="If you think we have got this wrong">
        <p>
          Tell us first, at the address below, and we will fix it. If you are in the EU or the UK
          and you are not satisfied with what we do about it, you also have the right to complain
          to the data protection authority where you live. Using that right does not cost you
          anything here.
        </p>
      </Section>

      <Section title="Children">
        <p>
          Editly is not for people under {ACCOUNT_MIN_AGE}, and we do not knowingly hold anything
          belonging to one. The terms say the same number, and so does the sign-up screen.
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
