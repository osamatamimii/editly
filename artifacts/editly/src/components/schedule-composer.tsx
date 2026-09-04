/**
 * Send this edit somewhere, at a time you choose.
 *
 * The last mile, and the one the product was missing. A finished clip that
 * still has to be downloaded, opened in five apps, uploaded five times and
 * captioned five times is a clip that sits in a folder for a week — which is
 * most of the work somebody came here to avoid.
 *
 * Three things this screen is careful about.
 *
 * **The limits are shown while you type, not after you press.** X stops at 280
 * characters, Snapchat at 250, and the count on screen is the same function the
 * API refuses on and the same one the worker holds the file against — imported
 * from `@workspace/api-zod/social`, not reimplemented here. A caption that is
 * fine on screen and refused by the server is a bug with no symptom until 9pm.
 *
 * **A per-platform caption appears only when one is needed.** Five text boxes
 * for five destinations is a form; one box, plus a shorter one for the single
 * platform that will not take it, is a decision. The override box only exists
 * for a platform whose limit the shared caption actually breaks.
 *
 * **Nothing is scheduled unless everything can be.** The API writes all the
 * rows or none of them, and this screen matches: the button says how many
 * destinations cannot take it rather than sending three of four and reporting
 * success.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { CalendarClock, Loader2, AlertTriangle, Check, Send } from "lucide-react";
import { refusalsFor, captionLength, captionLengthFor, MIN_LEAD_SECONDS } from "@workspace/api-zod/social";
import type { SocialPlatform } from "@workspace/api-zod/social";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import { PlatformMark, BRAND } from "@/components/platform-mark";
import type { PlatformInfo, ConnectedAccount } from "@/components/social-connections";
import { useLanguage } from "@/lib/language";
import { useDates } from "@/lib/dates";
import { COMPOSER } from "@/lib/copy/scheduled";
import { type Phrase } from "@/lib/app-copy";

interface Props {
  projectId: string;
  exportId?: string | null;
  platforms: PlatformInfo[];
  accounts: ConnectedAccount[];
  /** The finished edit's own shape and length — what the platforms judge. */
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  onScheduled?: () => void;
}

/** `datetime-local` wants a local wall-clock string with no zone on the end. */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * The times people actually pick.
 *
 * Not a convenience. Typing a date into a `datetime-local` on a phone is four
 * taps through a spinner, and the three moments below cover most of what
 * anybody schedules — which means the common case is one tap and the picker is
 * there for the rest.
 */
function quickTimes(now: Date): Array<{ id: string; label: Phrase; at: Date }> {
  const soon = new Date(now.getTime() + 60 * 60 * 1000);

  const tonight = new Date(now);
  tonight.setHours(19, 0, 0, 0);
  // Past seven already means tomorrow evening, not an hour that has gone.
  if (tonight.getTime() < now.getTime() + MIN_LEAD_SECONDS * 1000) {
    tonight.setDate(tonight.getDate() + 1);
  }

  const morning = new Date(now);
  morning.setDate(morning.getDate() + 1);
  morning.setHours(9, 0, 0, 0);

  return [
    { id: "in-an-hour", label: COMPOSER.inAnHour, at: soon },
    {
      // The same slot has two names depending on whether seven has already
      // gone, so the test id is the slot rather than the words on it.
      id: "evening-7pm",
      label: tonight.getDate() === now.getDate() ? COMPOSER.tonight : COMPOSER.tomorrowEvening,
      at: tonight,
    },
    { id: "tomorrow-9am", label: COMPOSER.tomorrowMorning, at: morning },
  ];
}

function splitTags(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((t) => t.replace(/^#+/, "").trim())
    .filter((t) => t.length > 0)
    .map((t) => `#${t}`);
}

export function ScheduleComposer({
  projectId,
  exportId,
  platforms,
  accounts,
  durationSeconds,
  width,
  height,
  onScheduled,
}: Props) {
  const { toast } = useToast();
  const { t, fmt, language } = useLanguage();
  const dates = useDates();
  const [selected, setSelected] = useState<string[]>([]);
  const [caption, setCaption] = useState("");
  const [tagText, setTagText] = useState("");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60 * 1000)));
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);

  const hashtags = useMemo(() => splitTags(tagText), [tagText]);
  const chosen = useMemo(
    () => accounts.filter((a) => selected.includes(a.id)),
    [accounts, selected],
  );

  /**
   * Every reason this will not go, per destination — the same function the
   * server refuses on, given the same facts.
   */
  const refusals = useMemo(
    () =>
      chosen.flatMap((account) => {
        const platform = account.platform as SocialPlatform;
        const text = overrides[account.platform] ?? caption;
        return refusalsFor(
          {
            platform,
            caption: text,
            hashtags,
            durationSeconds,
            width,
            height,
          },
          language,
        ).map((r) => ({ ...r, handle: account.handle, platform: account.platform }));
      }),
    [chosen, overrides, caption, hashtags, durationSeconds, width, height, language],
  );

  /**
   * The tightest limit among the places this is going.
   *
   * One number rather than five, because a person writing one caption is
   * writing against whichever platform will complain first. The others are
   * only interesting once that one is satisfied.
   */
  const tightest = useMemo(() => {
    const limits = chosen
      .map((a) => platforms.find((p) => p.platform === a.platform)?.captionLimit)
      .filter((n): n is number => typeof n === "number");
    return limits.length > 0 ? Math.min(...limits) : null;
  }, [chosen, platforms]);

  const used = captionLength(caption, hashtags);

  /** Platforms that need their own, shorter, wording. */
  const needsOwn = useMemo(
    () =>
      [...new Set(chosen.map((a) => a.platform))].filter((platform) =>
        refusalsFor(
          {
            platform: platform as SocialPlatform,
            caption,
            hashtags,
            durationSeconds,
            width,
            height,
          },
          language,
        ).some((r) => r.field === "caption"),
      ),
    [chosen, caption, hashtags, durationSeconds, width, height, language],
  );

  const schedule = async () => {
    setSending(true);
    try {
      const response = await apiFetch("/api/social/posts", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          exportId: exportId ?? undefined,
          accountIds: selected,
          caption,
          hashtags,
          captions: overrides,
          // The picker gives local wall-clock time; the server stores UTC. A
          // string without a zone is the bug where a post scheduled for 9pm
          // goes out at 9pm somewhere nobody lives.
          scheduledFor: new Date(when).toISOString(),
        }),
      });
      const body = (await response.json()) as {
        error?: string;
        refusals?: Array<{ handle: string; message: string }>;
      };
      if (!response.ok) {
        throw new Error(
          body.refusals?.length
            ? body.refusals.map((r) => `${r.handle}: ${r.message}`).join(" ")
            : (body.error ?? t(COMPOSER.couldNotSchedule)),
        );
      }
      setDone(true);
      onScheduled?.();
      toast({
        title: fmt(COMPOSER.scheduledTo, selected.length),
        description: fmt(COMPOSER.goingOut, dates.moment(new Date(when))),
      });
    } catch (error) {
      toast({
        title: t(COMPOSER.notScheduled),
        description: error instanceof Error ? error.message : t(COMPOSER.tryAgain),
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  };

  /*
    Nothing connected. Said once, plainly, with the reason and the way out.

    Not an empty grid, and not a disabled composer either: a form somebody
    cannot fill in reads as broken, while a sentence explaining that posting
    needs a reviewed app reads as a product that knows where it is.
  */
  if (accounts.length === 0) {
    const waiting = platforms.filter((p) => p.needsReview && !p.connected).length;
    return (
      <div
        className="rounded-xl border border-hairline bg-surface-1 p-4"
        data-testid="schedule-no-accounts"
      >
        <div className="flex items-center gap-2 text-sm font-semibold">
          <CalendarClock className="w-4 h-4 text-muted-foreground" />
          {t(COMPOSER.title)}
        </div>
        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
          {t(COMPOSER.noAccountsLead)}
          {waiting > 0 ? fmt(COMPOSER.someWaiting, waiting) : t(COMPOSER.nonePlatforms)}
        </p>
        <Link
          href="/account"
          className="text-sm text-primary hover:underline inline-block mt-3"
          data-testid="link-connections"
        >
          {t(COMPOSER.seeConnections)}
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div
        className="rounded-xl border border-success/30 bg-success/10 p-4 flex items-start gap-3"
        data-testid="schedule-done"
      >
        <Check className="w-5 h-5 text-success flex-shrink-0 mt-0.5" />
        <div>
          <div className="text-sm font-semibold">{t(COMPOSER.scheduled)}</div>
          <p className="text-sm text-muted-foreground mt-1">
            {fmt(COMPOSER.scheduledDetail, dates.moment(new Date(when)))}
          </p>
        </div>
      </div>
    );
  }

  const overLimit = tightest !== null && used > tightest;

  return (
    <div className="rounded-xl border border-hairline bg-surface-1 p-4 space-y-4" data-testid="schedule-composer">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <CalendarClock className="w-4 h-4 text-muted-foreground" />
        {t(COMPOSER.title)}
      </div>

      {/* Where. Tap targets are 44px on a phone, which is why these are not chips. */}
      <div className="flex flex-wrap gap-2" data-testid="schedule-destinations">
        {accounts.map((account) => {
          const on = selected.includes(account.id);
          return (
            <button
              key={account.id}
              type="button"
              onClick={() =>
                setSelected((prev) =>
                  prev.includes(account.id)
                    ? prev.filter((id) => id !== account.id)
                    : [...prev, account.id],
                )
              }
              aria-pressed={on}
              className={`no-default-hover-elevate inline-flex items-center gap-2 rounded-full min-h-11 md:min-h-9 px-3 text-sm transition-colors border ${
                on
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-hairline bg-band text-muted-foreground"
              }`}
              data-testid={`destination-${account.id}`}
            >
              <PlatformMark
                platform={account.platform}
                className={`w-4 h-4 flex-shrink-0 ${on ? (BRAND[account.platform] ?? "") : ""}`}
              />
              <span dir="auto" className="truncate max-w-[9rem]">{account.handle}</span>
            </button>
          );
        })}
      </div>

      <div>
        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          dir="auto"
          rows={3}
          placeholder={t(COMPOSER.captionPlaceholder)}
          className="w-full rounded-lg bg-background border border-hairline px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-primary/40"
          data-testid="input-caption"
        />
        <div className="flex items-center gap-2 mt-2">
          <input
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
            placeholder={t(COMPOSER.hashtagsPlaceholder)}
            dir="auto"
            className="flex-1 min-w-0 rounded-lg bg-background border border-hairline px-3 min-h-11 md:min-h-9 text-sm text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            data-testid="input-hashtags"
          />
          {tightest !== null ? (
            <span
              className={`text-xs tabular-nums flex-shrink-0 ${overLimit ? "text-destructive font-medium" : "text-muted-foreground"}`}
              dir="ltr"
              data-testid="caption-count"
            >
              {used} / {tightest}
            </span>
          ) : null}
        </div>
      </div>

      {/*
        A shorter caption, only for the platform that needs one.

        This appears when the shared caption breaks a specific limit and not
        before, which is the difference between a form and a decision.
      */}
      {needsOwn.map((platform) => {
        const limit = platforms.find((p) => p.platform === platform)?.captionLimit ?? 0;
        const label = platforms.find((p) => p.platform === platform)?.label ?? platform;
        const text = overrides[platform] ?? "";
        return (
          <div key={platform} data-testid={`override-${platform}`}>
            <label className="text-xs text-muted-foreground">
              {fmt(COMPOSER.shorterFor, label, limit.toLocaleString("en-US"))}
            </label>
            <textarea
              value={text}
              onChange={(e) => setOverrides((prev) => ({ ...prev, [platform]: e.target.value }))}
              dir="auto"
              rows={2}
              className="w-full mt-1 rounded-lg bg-background border border-hairline px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-primary/40"
              data-testid={`input-caption-${platform}`}
            />
            {/* Counted the way this platform counts. On X every URL is 23
                characters whatever its real length, so a counter showing what
                was typed says 340/280 for a post X would have taken.

                `dir="ltr"` because "128 / 280" is a pair of numbers around a
                slash, and in an Arabic paragraph the bidi algorithm puts the
                slash and the second number on the wrong side of the first. */}
            <div dir="ltr" className="text-end text-xs tabular-nums text-muted-foreground mt-0.5">
              {captionLengthFor(platform as SocialPlatform, text, hashtags)} / {limit}
            </div>
          </div>
        );
      })}

      <div>
        <div className="flex flex-wrap gap-2 mb-2">
          {quickTimes(new Date()).map((slot) => (
            <button
              key={slot.id}
              type="button"
              onClick={() => setWhen(toLocalInput(slot.at))}
              className="aura-chip no-default-hover-elevate rounded-full min-h-11 md:min-h-8 px-3 text-xs"
              data-testid={`quick-time-${slot.id}`}
            >
              {t(slot.label)}
            </button>
          ))}
        </div>
        <input
          type="datetime-local"
          value={when}
          min={toLocalInput(new Date(Date.now() + MIN_LEAD_SECONDS * 1000))}
          onChange={(e) => setWhen(e.target.value)}
          className="w-full rounded-lg bg-background border border-hairline px-3 min-h-11 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
          data-testid="input-when"
        />
      </div>

      {refusals.length > 0 ? (
        <ul className="space-y-1.5" data-testid="schedule-refusals">
          {refusals.map((refusal, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-warning leading-snug">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>
                <span dir="auto" className="font-medium">{refusal.handle}</span>: {refusal.message}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <Button
        className="w-full rounded-full min-h-11"
        disabled={selected.length === 0 || caption.trim().length === 0 || refusals.length > 0 || sending}
        onClick={schedule}
        data-testid="button-schedule"
      >
        {sending ? (
          <Loader2 className="w-4 h-4 me-2 animate-spin" />
        ) : (
          <Send className="w-4 h-4 me-2" />
        )}
        {selected.length === 0
          ? t(COMPOSER.pickWhere)
          : refusals.length > 0
            ? fmt(COMPOSER.thingsToFix, refusals.length)
            : fmt(COMPOSER.scheduleTo, selected.length)}
      </Button>
    </div>
  );
}
