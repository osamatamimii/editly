/**
 * Directing a moment instead of describing the whole video.
 *
 * Asked for directly: either you tell it what the whole video needs, or you
 * stop at a second and say "here, do this". The first has always existed; this
 * is the second.
 *
 * **A mark is not a new kind of instruction.** It is a timecode and a phrase,
 * and when the edit is generated they are folded into the same sentence typing
 * produces: "At 0:12 punch in. At 0:45 punch in." Both heads of the planner
 * read that — the keyword matcher parses `at m:ss` and the model is told to use
 * the numbers exactly — so nothing new is transported, no endpoint is added,
 * and every existing behaviour applies unchanged: the refusals, the language,
 * the rate limit, the reply that says what it will do before it does it.
 *
 * That is the same decision voice input made, for the same reason: a second
 * route into the renderer is a second copy of every rule, drifting from the
 * first.
 */
import { useState } from "react";
import { MapPin, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface Mark {
  /** Seconds on the source clock, where the playhead was. */
  at: number;
  /** What they said to do there, in their own words. */
  say: string;
}

/** m:ss, the way a person reads a player, not "12s". */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The marks as one sentence, in the order they happen.
 *
 * Sorted by time rather than by when they were added, because that is the order
 * they will be read in and the order the edit happens in. Each is its own
 * sentence so that one mark's words cannot run into the next one's.
 */
export function marksToSentence(marks: Mark[]): string {
  return [...marks]
    .sort((a, b) => a.at - b.at)
    .map((m) => {
      const said = m.say.trim().replace(/[.،,]+$/, "");
      return `At ${clock(m.at)} ${said}.`;
    })
    .join(" ");
}

export function MomentMarks({
  currentTime,
  marks,
  onChange,
  disabled = false,
}: {
  currentTime: number;
  marks: Mark[];
  onChange: (marks: Mark[]) => void;
  disabled?: boolean;
}) {
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState("");
  // Frozen when the form opens. Without this the mark would land wherever the
  // playhead had drifted to by the time they finished typing, which is the one
  // thing this feature must not get wrong.
  const [draftAt, setDraftAt] = useState(0);

  const add = () => {
    const said = draft.trim();
    if (!said) return;
    onChange([...marks, { at: draftAt, say: said }]);
    setDraft("");
    setDrafting(false);
  };

  return (
    <div className="mt-3" data-testid="moment-marks">
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            setDraftAt(currentTime);
            setDrafting(true);
          }}
          className="rounded-full gap-1.5 min-h-11 md:min-h-9"
          data-testid="button-add-mark"
        >
          <MapPin className="w-3.5 h-3.5" />
          Note this moment
          <span className="tabular-nums text-muted-foreground">{clock(currentTime)}</span>
        </Button>

        {marks.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {marks.length} {marks.length === 1 ? "moment" : "moments"} noted
          </span>
        )}
      </div>

      {drafting && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
          className="mt-2 flex items-center gap-2"
        >
          <span
            className="text-xs font-mono tabular-nums px-2 py-1 rounded-md bg-surface-2 text-muted-foreground flex-shrink-0"
            data-testid="text-mark-time"
          >
            {clock(draftAt)}
          </span>
          <Input
            autoFocus
            dir="auto"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDrafting(false);
                setDraft("");
              }
            }}
            placeholder="what should happen here?"
            className="h-11 md:h-9 rounded-full"
            data-testid="input-mark"
          />
          <Button type="submit" size="sm" className="rounded-full flex-shrink-0 min-h-11 md:min-h-9" data-testid="button-save-mark">
            Add
          </Button>
        </form>
      )}

      {marks.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1" data-testid="list-marks">
          {[...marks]
            .sort((a, b) => a.at - b.at)
            .map((m) => (
              <li
                key={`${m.at}-${m.say}`}
                className="flex items-center gap-2 text-sm rounded-lg bg-surface-1 border border-hairline-faint px-2 py-1.5"
              >
                <span className="font-mono tabular-nums text-xs text-secondary flex-shrink-0">{clock(m.at)}</span>
                <span dir="auto" className="min-w-0 truncate">
                  {m.say}
                </span>
                <button
                  type="button"
                  onClick={() => onChange(marks.filter((x) => !(x.at === m.at && x.say === m.say)))}
                  aria-label={`Remove the note at ${clock(m.at)}`}
                  className="ml-auto flex-shrink-0 h-11 w-11 md:h-8 md:w-8 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground"
                  data-testid="button-remove-mark"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
