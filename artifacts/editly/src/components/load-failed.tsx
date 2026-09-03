/**
 * What a screen shows when it could not read something.
 *
 * Two rules, both learned the hard way on 12 August, when every query in the
 * product failed for two days and the dashboard said "Nothing here yet".
 *
 * It must not look like an empty state. Same shape, same dashed border, same
 * polite tone, and it stops being information — the person reads "I have no
 * projects" and closes the tab.
 *
 * And it must say the work is safe. The first thought on seeing a blank library
 * is that the videos are gone, and someone who believes that does not retry,
 * they re-upload — or they leave.
 */
import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/language";
import { COMMON, LOAD } from "@/lib/copy/common";
import { type Phrase } from "@/lib/app-copy";

export function LoadFailed({
  what,
  onRetry,
  compact = false,
  testId = "load-failed",
}: {
  /** What could not be read, in the person's words: "your projects". */
  what: Phrase;
  onRetry?: () => void;
  /** For a stat tile or a banner, where a full panel would be absurd. */
  compact?: boolean;
  testId?: string;
}) {
  const { t, fmt } = useLanguage();

  if (compact) {
    return (
      <div className="flex items-center gap-2 text-sm text-warning" role="status" data-testid={testId}>
        <AlertTriangle className="w-4 h-4 flex-shrink-0" />
        <span>{fmt(LOAD.failedCompact, t(what))}</span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="underline underline-offset-2 hover:no-underline"
            data-testid={`${testId}-retry`}
          >
            {t(COMMON.retry)}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className="flex flex-col items-center justify-center py-24 text-center glass-panel rounded-2xl border border-warning/40"
      role="status"
      data-testid={testId}
    >
      <div className="w-16 h-16 rounded-full bg-warning/10 flex items-center justify-center mb-4 border border-warning/20">
        <AlertTriangle className="w-8 h-8 text-warning" />
      </div>
      <h3 className="text-xl font-bold mb-2">{fmt(LOAD.failedTitle, t(what))}</h3>
      <p className="text-muted-foreground max-w-sm mb-6">{t(LOAD.couldNotLoad)}</p>
      {onRetry && (
        <Button onClick={onRetry} variant="outline" className="rounded-full" data-testid={`${testId}-retry`}>
          <RotateCw className="w-4 h-4 me-2" />
          {t(COMMON.tryAgain)}
        </Button>
      )}
    </div>
  );
}
