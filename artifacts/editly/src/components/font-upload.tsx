/**
 * Adding a font of your own.
 *
 * The picker offers thirteen faces we chose. They are good and they are not
 * the one somebody's brand uses — a studio has a typeface, an agency's client
 * has a typeface, and the whole point of a caption is that it looks like it
 * came from them.
 *
 * ## Why this screen shows a font that is not ready, and one that was refused
 *
 * Because a font is not a file here. Whether it can be used at all, and the
 * three numbers a caption is drawn by, are settled by *rendering with it* on
 * the machine that will burn with it — nothing in a browser or a serverless
 * function can answer that. So there are a few seconds between uploading and
 * choosing, and there is a real possibility of "no".
 *
 * Both are shown. A row that says "measuring" is the difference between a
 * product that is working and one that looks broken; a row that says *why* it
 * was refused — no lam-alef shape, nothing on the frame came from the file —
 * is the difference between a second upload and a support message.
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, Upload, X, AlertTriangle, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/api-fetch";
import { uploadCaptionFont, UploadError } from "@/lib/video-storage";
import type { FaceScript } from "@workspace/api-zod/fonts";

export interface UploadedFace {
  id: string;
  label: string;
  declared: string | null;
  script: FaceScript;
  status: "pending" | "preparing" | "ready" | "refused";
  capRatio: number | null;
  widthScale: number | null;
  previewPath: string | null;
  refusal: string | null;
  bytes: number;
  createdAt: string;
}

/** What the person is told a font is doing, by status. */
const SAYING: Record<UploadedFace["status"], string> = {
  pending: "Waiting to be measured",
  preparing: "Measuring it, a few seconds",
  ready: "Ready",
  refused: "Cannot be used",
};

export function FontUpload({
  script,
  faces,
  userId,
  accessToken,
  onChanged,
  disabled,
}: {
  script: FaceScript;
  faces: UploadedFace[];
  userId: string;
  accessToken: string | null;
  onChanged: () => void;
  disabled?: boolean;
}) {
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const mine = faces.filter((face) => face.script === script);

  /*
    Ask again while something is being measured, and stop when nothing is.

    A poll that runs for ever costs a request every three seconds from every
    open tab in the product, for a thing that finishes in ten. This one exists
    only while there is an answer outstanding, and the dependency is the count
    of unfinished rows — so it starts on upload and stops on its own.
  */
  const waiting = mine.some((face) => face.status === "pending" || face.status === "preparing").valueOf();
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(onChanged, 3000);
    return () => clearInterval(timer);
  }, [waiting, onChanged]);

  async function choose(file: File) {
    if (!accessToken) {
      toast({ title: "Sign in again to add a font.", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const { path } = await uploadCaptionFont({ file, userId, accessToken });
      const response = await apiFetch("/api/fonts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path,
          // The file's own name, minus the extension. It is what the person
          // recognises the font by; what the file calls itself comes back from
          // the measurement and is shown underneath.
          label: file.name.replace(/\.[^.]+$/, "").slice(0, 120),
          script,
          bytes: file.size,
          /*
            Recorded, not verified, and nothing here can verify it.

            A font file carries no machine-readable statement of what its owner
            permits, and a name table saying "OFL" is a string somebody typed.
            The checkbox above this control is what puts the question; this is
            the answer being kept beside the file.
          */
          rights: "own",
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        toast({ title: body.error ?? "That font could not be added.", variant: "destructive" });
        return;
      }
      onChanged();
    } catch (error) {
      toast({
        title: error instanceof UploadError ? error.message : "That font could not be uploaded.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove(id: string) {
    const response = await apiFetch(`/api/fonts/${id}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      toast({ title: "Could not remove that font.", variant: "destructive" });
      return;
    }
    onChanged();
  }

  return (
    <div className="flex flex-col gap-2" data-testid={`font-upload-${script}`}>
      {mine.map((face) => (
        <div
          key={face.id}
          className={`flex items-start gap-2 rounded-xl border px-3 py-2 ${
            face.status === "refused" ? "border-destructive/40 bg-destructive/5" : "border-hairline bg-surface-1"
          }`}
          data-testid={`uploaded-face-${face.id}`}
        >
          <span className="flex-1 min-w-0 flex flex-col gap-0.5">
            <span dir="auto" className="text-xs font-medium truncate">{face.label}</span>
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {face.status === "ready" ? <Check className="w-3 h-3 flex-shrink-0" /> : null}
              {face.status === "refused" ? <AlertTriangle className="w-3 h-3 flex-shrink-0" /> : null}
              {face.status === "pending" || face.status === "preparing" ? (
                <Loader2 className="w-3 h-3 flex-shrink-0 animate-spin" />
              ) : null}
              <span dir="auto" className="leading-snug">
                {/*
                  The reason, when there is one, instead of the status word.
                  "Cannot be used" is not information; "it has no lam-alef
                  shape, so Arabic sentences would have empty boxes in them" is
                  a thing somebody can act on.
                */}
                {face.refusal ?? (face.declared && face.status === "ready" ? face.declared : SAYING[face.status])}
              </span>
            </span>
          </span>
          <button
            type="button"
            onClick={() => void remove(face.id)}
            className="text-muted-foreground hover:text-foreground p-1 -m-1 flex-shrink-0"
            aria-label={`Remove ${face.label}`}
            data-testid={`button-remove-face-${face.id}`}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}

      <input
        ref={input}
        type="file"
        accept=".ttf,.otf,.ttc,font/ttf,font/otf"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void choose(file);
        }}
        data-testid={`input-font-${script}`}
      />
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => input.current?.click()}
        className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-hairline px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors disabled:opacity-40"
        data-testid={`button-add-font-${script}`}
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
        Add your own font
      </button>
      {/*
        Said once, above the control, and not as a checkbox that blocks the
        upload.

        A checkbox nobody reads is a consent nobody gave. What this can honestly
        do is state the thing a person may not have considered — that their
        customers' videos are where this font ends up, which is a wider use than
        the licence on most fonts covers — and record that they were told.
      */}
      <p className="text-[11px] text-muted-foreground leading-snug">
        Use fonts you have the right to. Captions are burned into videos you and
        your clients publish, which most font licences treat differently from
        using a font on your own machine.
      </p>
    </div>
  );
}
