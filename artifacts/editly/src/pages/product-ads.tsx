/**
 * The section for people who sell things.
 *
 * Every other door into this product starts with a recording: somebody talks
 * to a camera, and the work is finding the good parts. A shop has no
 * recording. It has photographs of a product, a name and a price, and the
 * video it needs is one nobody is in.
 *
 * So this is its own screen rather than a second checkbox on the project
 * dialog. The dropzone there takes `video/*` and the editor refuses to render
 * until `videoPath` points at a video, which is a wall a merchant hits without
 * ever being told what this product could have done for them.
 *
 * It is also, deliberately, the same screen as the embedded Shopify app.
 * `routes/shopify.ts` gathers the photographs out of a store's catalogue and
 * this gathers them from files dragged onto a page; from the line where the
 * plan is built (`lib/product-ad.ts`) the two are one request. When the app
 * goes into Shopify's admin, what a merchant sees there is this, with the
 * pictures already filled in.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Loader2, ImagePlus, Store, X, ArrowRight } from "lucide-react";
import { useCreateProject, useGetSubscription, getGetSubscriptionQueryKey } from "@workspace/api-client-react";
import { BackButton } from "@/components/back-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { apiFetch, apiJson } from "@/lib/api-fetch";
import { loadState } from "@/lib/load-state";
import { assetKindOf, uploadProjectAsset, uploadCeiling, formatBytes, UploadError } from "@/lib/video-storage";

/**
 * As many photographs as the plan will carry.
 *
 * The same twelve the Shopify side takes off a product, and for the same
 * reason: past a dozen stills at a second each the advertisement is a
 * slideshow, and the reel operation's own ceiling is twenty. Kept as a
 * constant here rather than read from the server so a thirteenth file is
 * refused before it is uploaded, not after.
 */
const MAX_PHOTOS = 12;

/** What the bucket will take, by extension. See `uploadContentTypeFor`. */
const ACCEPT = ".jpg,.jpeg,.png,.webp";

const LENGTHS = [
  { seconds: 10, label: "10 seconds" },
  { seconds: 15, label: "15 seconds" },
  { seconds: 20, label: "20 seconds" },
  { seconds: 30, label: "30 seconds" },
];

const PLATFORMS = [
  { id: "tiktok", label: "TikTok" },
  { id: "reels", label: "Reels" },
  { id: "shorts", label: "Shorts" },
  { id: "square", label: "Feed" },
] as const;

type PlatformId = (typeof PLATFORMS)[number]["id"];

/** A chosen file and the object URL drawn for it, so the preview can be
 *  revoked when the file is dropped again. A leaked object URL holds the whole
 *  decoded image, and a merchant reorders a dozen of them. */
interface Chosen {
  id: string;
  file: File;
  url: string;
}

export default function ProductAdsPage() {
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const createProject = useCreateProject();
  const subscriptionQuery = useGetSubscription({ query: { queryKey: getGetSubscriptionQueryKey() } });

  const [chosen, setChosen] = useState<Chosen[]>([]);
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [platform, setPlatform] = useState<PlatformId>("tiktok");
  const [seconds, setSeconds] = useState(15);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Revoked on unmount, not on every render: the list is rebuilt on each add
  // and a cleanup keyed to it would revoke the URL of a picture still drawn.
  const liveUrls = useRef<string[]>([]);
  liveUrls.current = chosen.map((c) => c.url);
  useEffect(() => {
    const urls = liveUrls;
    return () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
    };
  }, []);

  /*
    What the bucket will really take for this account, and whether we know it.

    `uploadCeiling` falls back to the number this bundle was built with when
    the subscription has not arrived, which is the right behaviour and the
    wrong silence: a merchant on a paid plan whose subscription read failed
    would be told their photo is too large, in a sentence naming a limit that
    is not theirs. So the failure is a state, and it is said out loud once
    rather than mistaken for a fact about their file.
  */
  const subscriptionState = loadState(subscriptionQuery);
  const ceiling = uploadCeiling(subscriptionQuery.data);

  const add = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setError(null);
      const refused: string[] = [];
      const accepted: Chosen[] = [];

      for (const file of Array.from(files)) {
        if (assetKindOf(file) !== "image") {
          refused.push(`"${file.name}" is not a photo. Use jpg, png or webp.`);
          continue;
        }
        if (file.size > ceiling) {
          refused.push(`"${file.name}" is ${formatBytes(file.size)}. Keep each photo under ${formatBytes(ceiling)}.`);
          continue;
        }
        accepted.push({
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          url: URL.createObjectURL(file),
        });
      }

      setChosen((current) => {
        const room = MAX_PHOTOS - current.length;
        if (accepted.length > room) {
          // Named rather than silently truncated. A merchant who dropped
          // fifteen and got a video of twelve should know which three of their
          // photographs are not in it.
          refused.push(`Twelve photos is the most one ad can hold, so ${accepted.length - room} were left out.`);
        }
        return [...current, ...accepted.slice(0, Math.max(0, room))];
      });

      if (refused.length > 0) setError(refused.join(" "));
    },
    [ceiling],
  );

  const drop = (id: string) => {
    setChosen((current) => {
      const gone = current.find((c) => c.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return current.filter((c) => c.id !== id);
    });
  };

  /**
   * Create, upload, plan, open.
   *
   * The order matters and is the same order the Shopify side runs in: the row
   * exists before a byte is stored, because a file uploaded into a project id
   * that was never created is an orphan in somebody's bucket that nothing will
   * ever collect.
   */
  const build = async () => {
    if (chosen.length === 0 || !user) return;
    setError(null);

    const named = title.trim() || chosen[0]!.file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
    let projectId: string | null = null;

    try {
      setBusy("Making a place for it");
      const project = await createProject.mutateAsync({ data: { title: named || "Product ad" } });
      projectId = project.id;

      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Your session expired. Sign in again and the photos are still here.");

      // One at a time, in the order they were chosen. That order is the only
      // instruction the merchant gave about their own product, and uploading
      // in parallel would hand the server whatever finished first.
      for (const [index, item] of chosen.entries()) {
        setBusy(`Uploading photo ${index + 1} of ${chosen.length}`);
        const { path, kind } = await uploadProjectAsset({
          file: item.file,
          projectId: project.id,
          accessToken: token,
          ceiling,
        });
        const registered = await apiFetch(`/api/projects/${project.id}/assets`, {
          method: "POST",
          body: JSON.stringify({ path, kind, label: item.file.name, bytes: item.file.size }),
        });
        if (!registered.ok) {
          const body = (await registered.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Could not add "${item.file.name}".`);
        }
      }

      setBusy("Cutting the advertisement");
      const { ok, body } = await apiJson<{ error?: string }>("/api/product-ads", {
        method: "POST",
        body: JSON.stringify({
          id: project.id,
          title: named || undefined,
          price: price.trim() || undefined,
          platform,
          targetSeconds: seconds,
        }),
      });
      if (!ok) throw new Error(body.error ?? "The advertisement could not be started.");

      setLocation(`/project/${project.id}`);
    } catch (e) {
      setBusy(null);
      const message =
        e instanceof UploadError || e instanceof Error
          ? e.message
          : "Something went wrong before the advertisement was started.";
      // The project id, when there is one. Everything uploaded so far is in it,
      // and sending somebody back to an empty page to start over is this
      // product losing work it already has.
      setError(
        projectId
          ? `${message} What was uploaded is kept in the project, which you can open from the dashboard.`
          : message,
      );
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto px-6 py-12">
      <BackButton fallback="/dashboard" label="Dashboard" className="mb-6 -ml-4" />

      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
          <Store className="w-5 h-5 text-primary" />
        </div>
        <h1 className="text-3xl font-bold tracking-tight">Product ad</h1>
      </div>
      <p className="text-muted-foreground text-sm mb-8 max-w-2xl">
        Photos of what you sell, its name and its price. They come back as a video cut for the feed,
        with the product moving on screen instead of sitting still. No camera and nobody on screen.
      </p>

      {subscriptionState === "failed" ? (
        <p className="mb-6 text-sm text-muted-foreground" data-testid="product-ad-plan-unknown">
          Your plan could not be read just now, so photos are checked against the standard limit of{" "}
          {formatBytes(ceiling)}. Everything else works as usual.
        </p>
      ) : null}

      {/* The photos */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(e.dataTransfer.files);
        }}
        className={`rounded-2xl border border-dashed p-6 transition-colors ${
          dragging ? "border-primary bg-primary/5" : "border-hairline glass-panel"
        }`}
        data-testid="product-ad-dropzone"
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => {
            add(e.target.files);
            // Cleared so choosing the same file twice still fires a change.
            e.target.value = "";
          }}
          data-testid="input-product-photos"
        />

        {chosen.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <ImagePlus className="w-8 h-8 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground mb-4 max-w-sm">
              Drop your product photos here, up to twelve. The first one opens the ad, so put the
              shot you would use as the cover first.
            </p>
            <Button variant="outline" className="rounded-full" onClick={() => inputRef.current?.click()} data-testid="button-choose-photos">
              Choose photos
            </Button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3" data-testid="product-ad-photos">
              {chosen.map((item, index) => (
                <div
                  key={item.id}
                  className="relative aspect-square rounded-xl overflow-hidden border border-hairline-faint bg-surface-1"
                  data-testid={`product-photo-${index}`}
                >
                  <img src={item.url} alt={item.file.name} className="w-full h-full object-cover" />
                  {/* Which one opens the video, said on the picture rather than
                      in a paragraph above it that nobody reads. */}
                  {index === 0 ? (
                    <div className="absolute top-1 left-1 px-2 py-0.5 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold">
                      Cover
                    </div>
                  ) : (
                    <div className="absolute top-1 left-1 w-5 h-5 rounded-full bg-black/70 text-white text-[10px] font-semibold flex items-center justify-center">
                      {index + 1}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => drop(item.id)}
                    aria-label={`Remove ${item.file.name}`}
                    className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white flex items-center justify-center hover:bg-black"
                    data-testid={`button-remove-photo-${index}`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between mt-4">
              <p className="text-xs text-muted-foreground">
                {chosen.length} of {MAX_PHOTOS} photos. They play in this order.
              </p>
              <Button
                variant="outline"
                className="rounded-full"
                disabled={chosen.length >= MAX_PHOTOS}
                onClick={() => inputRef.current?.click()}
                data-testid="button-add-photos"
              >
                Add more
              </Button>
            </div>
          </>
        )}
      </div>

      {/* The words */}
      <div className="grid gap-5 sm:grid-cols-2 mt-8">
        <div>
          <Label htmlFor="product-title">Product name</Label>
          <Input
            id="product-title"
            dir="auto"
            value={title}
            maxLength={120}
            placeholder="Ceramic pour-over kettle"
            onChange={(e) => setTitle(e.target.value)}
            className="mt-2"
            data-testid="input-product-title"
          />
          <p className="text-xs text-muted-foreground mt-2">Goes on screen as the ad opens.</p>
        </div>
        <div>
          <Label htmlFor="product-price">Price</Label>
          <Input
            id="product-price"
            dir="auto"
            value={price}
            maxLength={40}
            placeholder="34.00 USD"
            onChange={(e) => setPrice(e.target.value)}
            className="mt-2"
            data-testid="input-product-price"
          />
          {/* Free text, and left that way on purpose: a currency picker is this
              product having an opinion about a shop's own price. */}
          <p className="text-xs text-muted-foreground mt-2">
            Optional, and written however you write it. Shown near the end.
          </p>
        </div>
      </div>

      {/* The shape */}
      <div className="grid gap-5 sm:grid-cols-2 mt-6">
        <div>
          <Label>Where it is going</Label>
          <div className="flex flex-wrap gap-2 mt-2">
            {PLATFORMS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setPlatform(option.id)}
                className={`aura-chip no-default-hover-elevate rounded-full px-4 min-h-9 text-xs font-medium ${
                  platform === option.id ? "ring-1 ring-primary text-foreground" : "text-muted-foreground"
                }`}
                aria-pressed={platform === option.id}
                data-testid={`button-platform-${option.id}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <Label>How long</Label>
          <div className="flex flex-wrap gap-2 mt-2">
            {LENGTHS.map((option) => (
              <button
                key={option.seconds}
                type="button"
                onClick={() => setSeconds(option.seconds)}
                className={`aura-chip no-default-hover-elevate rounded-full px-4 min-h-9 text-xs font-medium ${
                  seconds === option.seconds ? "ring-1 ring-primary text-foreground" : "text-muted-foreground"
                }`}
                aria-pressed={seconds === option.seconds}
                data-testid={`button-length-${option.seconds}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error ? (
        <p className="mt-6 text-sm text-destructive" role="alert" data-testid="product-ad-error">
          {error}
        </p>
      ) : null}

      <div className="mt-8 flex items-center gap-4">
        <Button
          onClick={() => void build()}
          disabled={chosen.length === 0 || busy !== null}
          className="rounded-full px-6 h-12"
          data-testid="button-make-product-ad"
        >
          {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ArrowRight className="w-4 h-4 mr-2" />}
          {busy ?? "Make the ad"}
        </Button>
        {chosen.length === 0 ? (
          <p className="text-xs text-muted-foreground">Add at least one photo.</p>
        ) : null}
      </div>
    </div>
  );
}
