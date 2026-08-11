import { AlertCircle } from "lucide-react";
import { BackButton } from "@/components/back-button";

/**
 * The 404. It used to ask "Did you forget to add the page to the router?" on a
 * light grey card — a note from a developer to themselves, shown to whoever
 * mistyped a URL. It now says what happened and offers the two ways out.
 */
export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="w-14 h-14 rounded-full bg-surface-1 border border-hairline flex items-center justify-center">
        <AlertCircle className="w-7 h-7 text-muted-foreground" />
      </div>
      <h1 className="text-2xl font-bold">This page does not exist</h1>
      <p className="text-muted-foreground max-w-sm">
        The link may be out of date, or the address slightly off.
      </p>
      <div className="flex items-center gap-2 mt-2">
        <BackButton fallback="/" label="Back" variant="outline" testId="button-back-404" />
      </div>
    </div>
  );
}
