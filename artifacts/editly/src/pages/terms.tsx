/**
 * What somebody agrees to by using this, in the fewest words that are true.
 *
 * The other document every platform review asks for, and the one Freemius has
 * been selling without.
 *
 * Written short on purpose. A long terms page is not more protective; it is
 * less read, and the two clauses here that actually matter — the licence we
 * take in somebody's video, and who is responsible for the fonts and footage
 * they upload — get buried by twelve pages of boilerplate nobody negotiated.
 *
 * The missing company details are drawn as missing, the same way the privacy
 * page draws them, and for the reason written there.
 */
import { Link } from "wouter";
import { BackButton } from "@/components/back-button";
import { PendingDetail, PendingNotice } from "@/components/pending-detail";
import { ACCOUNT_MIN_AGE } from "@workspace/api-zod/processors";

const UPDATED = "31 August 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

export default function Terms() {
  return (
    <div className="min-h-screen px-4 sm:px-6 py-6 sm:py-10 max-w-3xl mx-auto flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <BackButton fallback="/" />
        <h1 className="text-2xl sm:text-3xl font-bold">Terms of use</h1>
        <p className="text-sm text-muted-foreground">Last updated {UPDATED}.</p>
      </div>

      <PendingNotice />

      <Section title="What this is">
        <p>
          Editly takes a video you upload and edits it the way you describe. You keep an
          account, you spend minutes of rendering from a plan, and you get files back.
        </p>
      </Section>

      <Section title="Your video stays yours">
        <p>
          {/*
            The clause that matters most, and the one most products get wrong in
            their own favour. The licence taken here is exactly what running the
            product requires and stops there.
          */}
          You own what you upload and you own what comes out. You give us permission to store,
          copy, transcode and process your files <em>only</em> so far as it takes to run the
          product for you: cut them, caption them, and hand them back. That permission ends
          when you delete the file.
        </p>
        <p>
          We do not use your videos to train models, we do not licence them to anyone, and we
          do not show them to anyone.
        </p>
      </Section>

      <Section title="What you upload has to be yours to upload">
        <p>
          Footage, music, images and <strong className="text-foreground">fonts</strong>. The
          font one is worth saying plainly because it catches people: a typeface licence that
          covers using a font on your own machine often does not cover burning it into videos
          you publish, and never covers your clients' videos. Uploading a font here is you
          saying you have the right to use it that way.
        </p>
        <p>
          We cannot check any of this and do not try to. If somebody tells us a file infringes
          their rights, we will take it down.
        </p>
      </Section>

      <Section title="Who may have an account">
        <p>
          {/*
            The contract never said. The privacy page did, the sign-up screen
            now does, and this is the document that actually binds — so a
            number in two of the three was a number in none of them.
            `privacy-test` compares all three.
          */}
          You need to be {ACCOUNT_MIN_AGE} or over to have an Editly account. If you are under
          that, this is not for you yet, and we do not knowingly hold anything belonging to
          somebody who is.
        </p>
      </Section>

      <Section title="What you may not do with it">
        <p>
          Anything illegal where you are. Anything that puts a real person in a video they did
          not agree to be in. Anything that impersonates somebody. And nothing sexual involving
          anyone under 18, which is the one line where we will hand what we hold to the
          authorities rather than only closing the account.
        </p>
      </Section>

      <Section title="Plans, minutes and refunds">
        <p>
          Plans are monthly and are billed by Freemius, who are the merchant of record. A plan
          includes a number of rendered minutes; they reset each month and do not roll over.
        </p>
        <p>
          Cancel whenever you like. Your plan runs to the end of the period you paid for and
          then stops. For a refund, ask us: within the first fourteen days we will give one
          without argument.
        </p>
        <p>
          The free plan puts a small mark on what it makes. Every paid plan does not.
        </p>
      </Section>

      <Section title="Posting to your accounts">
        <p>
          If you connect a social account, we post only what you scheduled, to the account you
          connected, at the time you chose. You can disconnect any account at any moment, and
          doing so cancels anything still queued for it.
        </p>
        <p>
          Those platforms have their own rules about what may be posted, and we cannot post
          something they refuse. When one refuses, we tell you what they said.
        </p>
      </Section>

      <Section title="What we do not promise">
        <p>
          {/*
            An honest limitation rather than the usual wall of capitals. This
            product renders video on machines that can be busy and calls
            providers that can be down, and saying so is better than an
            "AS IS" clause nobody reads.
          */}
          That every render will succeed, that the product will be available every minute, or
          that an automatic edit will be the edit you would have made by hand. When a render
          fails, it does not cost you minutes.
        </p>
        <p>
          We are not liable for indirect or consequential losses. Where we are liable, it is
          limited to what you paid us in the twelve months before.
        </p>
      </Section>

      <Section title="Ending it">
        <p>
          You can delete your account from the account screen whenever you want. We can close
          an account that breaks the rules above, and if we do we will say which one. An
          account closed with no reason given is a thing we will not do.
        </p>
      </Section>

      <Section title="The rest">
        <p>
          These terms are governed by the laws of <PendingDetail what="Governing law" />. If we
          change them in a way that matters, we will tell you by email rather than only editing
          this page.
        </p>
        <p>
          Editly is operated by <PendingDetail what="Registered company name" />,{" "}
          <PendingDetail what="Registered address" />. Reach us at{" "}
          <PendingDetail what="Support address" />.
        </p>
      </Section>

      <p className="text-xs text-muted-foreground pt-4 border-t border-hairline">
        See also the <Link href="/privacy" className="text-primary hover:underline">privacy page</Link>.
      </p>
    </div>
  );
}
