/**
 * The section for people who sell things.
 *
 * Every other door into this product starts with a recording of somebody
 * talking, and the work is finding the good parts. This one starts with a
 * shop: clips of a product, photographs of it, a name, a price, and a sentence
 * saying what the advertisement should be like.
 *
 * It is its own screen rather than a second checkbox on the project dialog,
 * because what it asks for is different: several files at once, in an order
 * that matters, plus words that only make sense next to them.
 *
 * **A clip is required.** This screen was first built for photographs alone,
 * and that was the wrong product: a dropshipper has supplier footage and phone
 * clips and somebody holding the thing, and the photographs cover the gaps
 * between them. An advertisement made of stills is what this falls back to for
 * a catalogue product with no video, and it is the weaker of the two, so it is
 * not what the main road offers.
 *
 * It is also, deliberately, the same screen as the embedded Shopify app.
 * `routes/shopify.ts` gathers the material out of a store's catalogue and this
 * gathers it from files dragged onto a page; from the line where the plan is
 * built (`lib/product-ad.ts`) the two are one request.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Loader2, ImagePlus, Store, X, ArrowRight, Film } from "lucide-react";
import { useCreateProject, useGetSubscription, getGetSubscriptionQueryKey } from "@workspace/api-client-react";
import { BackButton } from "@/components/back-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { apiFetch, apiJson } from "@/lib/api-fetch";
import { loadState } from "@/lib/load-state";
import {
  assetKindOf,
  uploadProjectAsset,
  uploadCeiling,
  formatBytes,
  readVideoFacts,
  UploadError,
} from "@/lib/video-storage";

/** How many clips one advertisement will use. The first is the ad; the rest are cut over it. */
const MAX_CLIPS = 6;
/**
 * And how many photographs.
 *
 * The same twelve the Shopify side takes off a product, and refused here
 * rather than after the upload so a thirteenth costs nothing.
 */
const MAX_PHOTOS = 12;

/** What the bucket will take, by extension. See `uploadContentTypeFor`. */
const ACCEPT = ".mp4,.mov,.webm,.m4v,.jpg,.jpeg,.png,.webp";

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

/**
 * A chosen file and the object URL drawn for it, so the preview can be revoked
 * when the file is dropped again. A leaked object URL holds the whole decoded
 * frame, and a merchant reorders a dozen of them.
 */
interface Chosen {
  id: string;
  file: File;
  url: string;
  kind: "video" | "image";
}

export default function ProductAdsPage() {
  const [, setLocation] = useLocation();
  const createProject = useCreateProject();
  const subscriptionQuery = useGetSubscription({ query: { queryKey: getGetSubscriptionQueryKey() } });

  const [chosen, setChosen] = useState<Chosen[]>([]);
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
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
    would be told their clip is too large, in a sentence naming a limit that is
    not theirs. So the failure is a state, and it is said out loud once rather
    than mistaken for a fact about their file.
  */
  const subscriptionState = loadState(subscriptionQuery);
  const ceiling = uploadCeiling(subscriptionQuery.data);

  const clips = chosen.filter((c) => c.kind === "video");
  const photos = chosen.filter((c) => c.kind === "image");

  const add = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setError(null);
      const refused: string[] = [];
      const accepted: Chosen[] = [];

      for (const file of Array.from(files)) {
        const kind = assetKindOf(file);
        if (kind !== "video" && kind !== "image") {
          refused.push(`"${file.name}" is not a clip or a photo. Use mp4, mov, webm, jpg, png or webp.`);
          continue;
        }
        if (file.size > ceiling) {
          refused.push(`"${file.name}" is ${formatBytes(file.size)}. Keep each file under ${formatBytes(ceiling)}.`);
          continue;
        }
        accepted.push({
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          url: URL.createObjectURL(file),
          kind,
        });
      }

      setChosen((current) => {
        // Counted per kind, because the two have different ceilings and a
        // shared one would refuse a clip because somebody added photographs.
        let clipRoom = MAX_CLIPS - current.filter((c) => c.kind === "video").length;
        let photoRoom = MAX_PHOTOS - current.filter((c) => c.kind === "image").length;
        const taken: Chosen[] = [];
        let overClips = 0;
        let overPhotos = 0;
        for (const item of accepted) {
          if (item.kind === "video") {
            if (clipRoom > 0) {
              clipRoom -= 1;
              taken.push(item);
            } else overClips += 1;
          } else if (photoRoom > 0) {
            photoRoom -= 1;
            taken.push(item);
          } else overPhotos += 1;
        }
        // Named rather than silently truncated. A merchant who dropped fifteen
        // files and got a video made of twelve should know which ones are not
        // in it.
        if (overClips > 0) refused.push(`${MAX_CLIPS} clips is the most one ad uses, so ${overClips} were left out.`);
        if (overPhotos > 0) refused.push(`${MAX_PHOTOS} photos is the most one ad holds, so ${overPhotos} were left out.`);
        for (const item of accepted) if (!taken.includes(item)) URL.revokeObjectURL(item.url);
        return [...current, ...taken];
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
    if (clips.length === 0) return;
    setError(null);

    const named = title.trim() || clips[0]!.file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
    let projectId: string | null = null;

    try {
      setBusy("Making a place for it");
      const project = await createProject.mutateAsync({ data: { title: named || "Product ad" } });
      projectId = project.id;

      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Your session expired. Sign in again and your files are still here.");

      // One at a time, in the order they were chosen. That order is the only
      // instruction the merchant gave about their own product, and uploading in
      // parallel would hand the server whatever finished first.
      const ordered = [...clips, ...photos];
      for (const [index, item] of ordered.entries()) {
        setBusy(`Uploading ${index + 1} of ${ordered.length}`);

        /*
          Measured here, where the file is, because nothing downstream can.

          The server judges the month's allowance and the upload ceiling
          against `projects.duration`, and the only place a duration can be
          read without downloading the file is the browser that already holds
          it. A clip that will not report its length is uploaded anyway and the
          worker re-checks the real file; refusing an advertisement over a
          metadata read would be this screen inventing a rule.
        */
        let facts: { duration: number; width: number; height: number } | null = null;
        if (item.kind === "video") {
          facts = await readVideoFacts(item.file).catch(() => null);
        }

        const { path, kind } = await uploadProjectAsset({
          file: item.file,
          projectId: project.id,
          accessToken: token,
          ceiling,
        });
        const registered = await apiFetch(`/api/projects/${project.id}/assets`, {
          method: "POST",
          body: JSON.stringify({
            path,
            kind,
            label: item.file.name,
            bytes: item.file.size,
            ...(facts
              ? {
                  durationSeconds: facts.duration,
                  width: facts.width,
                  height: facts.height,
                }
              : {}),
          }),
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
          description: description.trim() || undefined,
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
      // The project, when there is one. Everything uploaded so far is in it,
      // and sending somebody back to an empty page to start over is this
      // product losing work it already has.
      setError(
        projectId
          ? `${message} What was uploaded is kept in the project, which you can open from the dashboard.`
          : message,
      );
    }
  };

  const tile = (item: Chosen, index: number, label: string) => (
    <div
      key={item.id}
      className="relative aspect-square rounded-xl overflow-hidden border border-hairline-faint bg-surface-1"
      data-testid={`product-file-${item.kind}-${index}`}
    >
      {item.kind === "video" ? (
        // A real frame rather than a film icon: a merchant with four supplier
        // clips named 1.mp4 through 4.mp4 cannot order what they cannot see.
        <video
          src={`${item.url}#t=0.5`}
          muted
          playsInline
          preload="metadata"
          className="w-full h-full object-cover"
        />
      ) : (
        <img src={item.url} alt={item.file.name} className="w-full h-full object-cover" />
      )}
      <div className="absolute top-1 left-1 px-2 py-0.5 rounded-full bg-black/70 text-white text-[10px] font-semibold">
        {label}
      </div>
      <button
        type="button"
        onClick={() => drop(item.id)}
        aria-label={`Remove ${item.file.name}`}
        className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white flex items-center justify-center hover:bg-black"
        data-testid={`button-remove-${item.kind}-${index}`}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );

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
        Your clips of the product, the photos you have of it, and what you want the ad to be like.
        They come back cut for the feed: the footage carries it, the photos cut in over the top.
      </p>

      {subscriptionState === "failed" ? (
        <p className="mb-6 text-sm text-muted-foreground" data-testid="product-ad-plan-unknown">
          Your plan could not be read just now, so files are checked against the standard limit of{" "}
          {formatBytes(ceiling)}. Everything else works as usual.
        </p>
      ) : null}

      {/* The material */}
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
          data-testid="input-product-files"
        />

        {chosen.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <div className="flex items-center gap-2 mb-3 text-muted-foreground">
              <Film className="w-8 h-8" />
              <ImagePlus className="w-7 h-7 opacity-60" />
            </div>
            <p className="text-sm text-muted-foreground mb-4 max-w-sm">
              Drop your clips of the product here, and any photos with them. The first clip opens
              the ad, and the rest cut in over it.
            </p>
            <Button
              variant="outline"
              className="rounded-full"
              onClick={() => inputRef.current?.click()}
              data-testid="button-choose-files"
            >
              Choose files
            </Button>
          </div>
        ) : (
          <>
            {clips.length > 0 ? (
              <>
                <p className="text-xs font-medium mb-2">Clips, in order</p>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3" data-testid="product-ad-clips">
                  {clips.map((item, index) => tile(item, index, index === 0 ? "Opens the ad" : String(index + 1)))}
                </div>
              </>
            ) : null}

            {photos.length > 0 ? (
              <>
                <p className="text-xs font-medium mt-4 mb-2">Photos, cut in over the footage</p>
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3" data-testid="product-ad-photos">
                  {photos.map((item, index) => tile(item, index, String(index + 1)))}
                </div>
              </>
            ) : null}

            <div className="flex items-center justify-between mt-4 gap-3">
              <p className="text-xs text-muted-foreground">
                {clips.length} {clips.length === 1 ? "clip" : "clips"} and {photos.length}{" "}
                {photos.length === 1 ? "photo" : "photos"}.
              </p>
              <Button
                variant="outline"
                className="rounded-full"
                disabled={clips.length >= MAX_CLIPS && photos.length >= MAX_PHOTOS}
                onClick={() => inputRef.current?.click()}
                data-testid="button-add-files"
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

      {/* And the sentence, which is where the ad is really decided. */}
      <div className="mt-6">
        <Label htmlFor="product-description">What should the ad be like?</Label>
        {/* A plain textarea with the same classes `schedule-composer` uses.
            There is no `ui/textarea` in this design system, and adding one for
            a single field is a component nobody else will find. */}
        <textarea
          id="product-description"
          dir="auto"
          value={description}
          maxLength={600}
          rows={3}
          placeholder="Cut it fast with big subtitles and music under it. Keep her voice."
          onChange={(e) => setDescription(e.target.value)}
          className="mt-2 w-full rounded-lg bg-background border border-hairline px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-primary/40"
          data-testid="input-product-description"
        />
        <p className="text-xs text-muted-foreground mt-2">
          Optional, in English or Arabic. Anything you ask for here wins over the defaults: music,
          subtitles, how hard the cuts are, whether the voice in your clip stays.
        </p>
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
          disabled={clips.length === 0 || busy !== null}
          className="rounded-full px-6 h-12"
          data-testid="button-make-product-ad"
        >
          {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ArrowRight className="w-4 h-4 mr-2" />}
          {busy ?? "Make the ad"}
        </Button>
        {/* Said here, next to the button that will not move, rather than after
            they press it. The photo-only case is the common mistake and gets
            its own sentence. */}
        {clips.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="product-ad-needs-clip">
            {photos.length > 0
              ? "Add at least one clip of the product, and your photos will cut in over it."
              : "Add a clip of the product to start."}
          </p>
        ) : null}
      </div>
    </div>
  );
}
