/**
 * Whether this upload may happen, and where it goes if it may.
 *
 * Every refusal in this product used to arrive from Storage. The browser sent
 * bytes with the user's own token, the bucket answered 400 for a type it does
 * not hold or 413 for a file over a ceiling nobody here could read, and our
 * server was never on the path: no log line, and on screen a status code. That
 * is the shape of failure this repository keeps finding, and it is the one an
 * object store cannot help with, because the store does not know what a
 * reference clip is for or how many files a project may keep.
 *
 * So the decision is ours and it happens here, before anything is signed.
 *
 * ## Pure on purpose
 *
 * Nothing in this module reaches a database, an object store or the clock
 * except through its arguments. The route reads the counts and the ceiling and
 * hands them in; what comes back is either a key and a content type or a
 * refusal carrying the sentence a person will read. That is what makes the
 * whole table of decisions testable without a bucket, a Postgres or a browser,
 * and a decision that is only checkable end to end is one that gets checked
 * once.
 *
 * ## The rules, and why each is where it is
 *
 * **The key is built, never accepted.** It starts with the verified user id, so
 * another account's folder is unspellable rather than rejected. The leaf is
 * generated for the two purposes that can hold many files, because a filename
 * is the one part of an upload somebody fully controls.
 *
 * **The type comes from the extension**, through the one table every other
 * upload path in this product already shares, and a miss is a refusal rather
 * than a default. Falling back to `video/mp4` for an unknown file would upload
 * a PDF as a video and fail much further along, where the sentence would have
 * to be about a filter graph.
 *
 * **Every ceiling is a minimum of two numbers**: the bucket's, which the route
 * asks Storage for, and this product's own for that purpose. A ceiling above
 * the bucket's is the bug the extra-files panel had for months, promising 512
 * MB against a bucket that stopped at 50.
 */
import {
  uploadContentTypeFor,
  uploadKindFor,
  type UploadContentType,
} from "@workspace/api-zod/limits";
import { formatBytes, type UploadPurpose } from "@workspace/api-zod/uploads";
import { isSafeKey } from "@workspace/object-store";

/**
 * What a reference clip may weigh.
 *
 * Held far below the bucket on purpose: the worker only ever reads the first
 * couple of minutes of one to take its look, so a whole episode uploaded as a
 * reference is minutes of somebody's transfer spent on bytes we discard.
 *
 * The browser carries the same number so it can refuse before the network is
 * touched. Two copies of a number is a thing this repository normally refuses,
 * and `tools/uploads-test.mjs` is what makes it safe: it reads both files and
 * fails when they disagree. The alternative was the frontend importing a
 * server module, which is a heavier coupling than one asserted constant.
 */
export const MAX_REFERENCE_BYTES = 25 * 1024 * 1024;

/** A text face is under two megabytes; ten is a CJK family nobody burns captions with. */
export const MAX_FONT_BYTES = 8 * 1024 * 1024;

/**
 * A poster frame, which this product encodes itself.
 *
 * Nothing a person chooses arrives on this path: `captureThumbnail` draws one
 * frame to a canvas and encodes it at quality 0.82, which is a couple of
 * hundred kilobytes at 4K. The cap is here so that the purpose cannot be used
 * as a way to put an arbitrary file into a project's folder under a name the
 * dashboard will happily render.
 */
export const MAX_POSTER_BYTES = 4 * 1024 * 1024;

/**
 * Above this a file is worth resuming.
 *
 * The same six megabytes the browser sends per chunk, which is what makes the
 * threshold meaningful: below it a resumable upload is one chunk and a POST, a
 * HEAD and a PATCH to achieve what one request does.
 */
export const RESUMABLE_ABOVE_BYTES = 6 * 1024 * 1024;

/** How long a minted URL is good for. Long enough for a slow phone on a train. */
export const TICKET_TTL_SECONDS = 60 * 60;

export interface UploadQuota {
  used: number;
  allowed: number;
  /** What the person is being told they have too many of. Plural, lowercase. */
  noun: string;
}

export interface UploadContext {
  /** From the verified token. The first segment of every key this returns. */
  userId: string;
  /** What Storage says it will take, or our fallback when it will not say. */
  ceilingBytes: number;
  quota?: UploadQuota;
  /**
   * The random part of a generated leaf.
   *
   * An argument rather than a call so the decision stays a pure function of its
   * inputs, and so a suite can assert the shape of a key rather than match a
   * regex against a random one. Required rather than defaulted, because a
   * default here is two uploads into one project quietly sharing a key.
   */
  stamp: string;
}

export interface UploadRequest {
  purpose: UploadPurpose;
  filename: string;
  bytes: number;
  projectId?: string | undefined;
}

export interface UploadPlan {
  key: string;
  contentType: UploadContentType;
  /** The ceiling this was measured against, for the ticket to say out loud. */
  maxBytes: number;
}

/**
 * Why an upload was refused.
 *
 * A code for the log and a sentence for the screen, which are different
 * audiences and were the same string for too long. The code is what makes a
 * month of refusals countable; the sentence is what makes one of them
 * actionable.
 */
export type RefusalReason =
  | "no-project"
  | "unsafe-key"
  | "unknown-type"
  | "wrong-kind"
  | "empty-file"
  | "too-large"
  | "quota";

export interface UploadRefusal {
  status: 400 | 409 | 413;
  reason: RefusalReason;
  message: string;
}

export type UploadDecision =
  | { ok: true; plan: UploadPlan }
  | { ok: false; refusal: UploadRefusal };

const refuse = (
  status: UploadRefusal["status"],
  reason: RefusalReason,
  message: string,
): UploadDecision => ({ ok: false, refusal: { status, reason, message } });

/**
 * The extension, lowercased, and only when it is one this product knows.
 *
 * Taken from the name rather than from the content type because two of the
 * types map from several extensions and a person who uploaded `holiday.MOV`
 * should find `source.mov`, not `source.mp4`. Bounded to what a safe key
 * segment may contain, so nothing from the filename can reach the key except
 * these few characters.
 */
function extensionOf(filename: string): string | null {
  const raw = (filename.split(".").pop() ?? "").toLowerCase();
  return /^[a-z0-9]{2,5}$/.test(raw) ? raw : null;
}

/** Which kinds each purpose will accept, and the sentence when it does not. */
const ACCEPTS: Record<
  UploadPurpose,
  {
    kinds: ReadonlyArray<string>;
    /** Narrower than a kind, where the purpose really does mean one format. */
    types?: ReadonlyArray<UploadContentType>;
    refusal: (name: string) => string;
  }
> = {
  source: {
    kinds: ["video"],
    refusal: (name) => `A project is edited from a video. "${name}" is not one.`,
  },
  asset: {
    kinds: ["video", "image", "audio"],
    refusal: (name) =>
      `We can use video, images and audio. "${name}" is none of those, so there is nothing an edit could do with it.`,
  },
  reference: {
    kinds: ["video"],
    refusal: (name) => `A reference is a video whose look this edit should match. "${name}" is not a video.`,
  },
  thumbnail: {
    kinds: ["image"],
    // One format rather than three, because the key is the fixed name
    // `thumb.jpg` and an object called that holding a WebP is a file whose
    // name lies about it. The only caller encodes the frame itself.
    types: ["image/jpeg"],
    refusal: () => "A poster frame is stored as a JPEG.",
  },
  font: {
    kinds: ["font"],
    refusal: (name) => `"${name}" is not a font file. Fonts end in .ttf, .otf or .ttc.`,
  },
};

/** Which purposes live inside a project, and therefore need one named. */
const NEEDS_PROJECT: Record<UploadPurpose, boolean> = {
  source: true,
  asset: true,
  reference: true,
  thumbnail: true,
  font: false,
};

/**
 * The key, once the purpose and the extension are settled.
 *
 * Three of these are fixed names because a project has exactly one of each and
 * a second upload should replace the first rather than leave the old bytes
 * paid for and unreferenced. The two that can hold many files get a generated
 * leaf, which is also the reason nothing from the filename is in it.
 */
function keyFor(
  purpose: UploadPurpose,
  context: UploadContext,
  projectId: string,
  extension: string,
  stamp: string,
): string {
  switch (purpose) {
    case "source":
      return `${context.userId}/${projectId}/source.${extension}`;
    case "reference":
      return `${context.userId}/${projectId}/reference.${extension}`;
    case "thumbnail":
      return `${context.userId}/${projectId}/thumb.jpg`;
    case "asset":
      return `${context.userId}/${projectId}/asset-${stamp}.${extension}`;
    case "font":
      // A person's folder, not a project's: the whole point of uploading a
      // typeface is that it is there in the next project too.
      return `${context.userId}/fonts/font-${stamp}.${extension}`;
  }
}

/** This product's own ceiling for a purpose, before the bucket has its say. */
function ownCeiling(purpose: UploadPurpose): number | null {
  if (purpose === "reference") return MAX_REFERENCE_BYTES;
  if (purpose === "font") return MAX_FONT_BYTES;
  if (purpose === "thumbnail") return MAX_POSTER_BYTES;
  return null;
}

export function planUpload(request: UploadRequest, context: UploadContext): UploadDecision {
  const { purpose, filename, bytes } = request;

  if (NEEDS_PROJECT[purpose] && !request.projectId) {
    return refuse(400, "no-project", "That upload belongs to a project, and none was named.");
  }

  // Before the type, because "0 bytes" is the honest cause and a person who
  // dragged a file that is still syncing from a cloud drive gets to hear it
  // rather than a sentence about formats.
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    return refuse(400, "empty-file", `"${filename}" has no contents, so there is nothing to upload.`);
  }

  const contentType = uploadContentTypeFor(filename);
  const kind = uploadKindFor(filename);
  const extension = extensionOf(filename);
  if (!contentType || !kind || !extension) {
    return refuse(
      400,
      "unknown-type",
      `We cannot do anything with "${filename}". Send a video, an image, an audio file or a font.`,
    );
  }
  const accepts = ACCEPTS[purpose];
  if (!accepts.kinds.includes(kind) || (accepts.types && !accepts.types.includes(contentType))) {
    return refuse(400, "wrong-kind", accepts.refusal(filename));
  }

  const own = ownCeiling(purpose);
  const maxBytes = own === null ? context.ceilingBytes : Math.min(own, context.ceilingBytes);
  if (bytes > maxBytes) {
    /*
      413, and the number is named.

      The old sentence deliberately did not name a limit, and it was right to:
      it was written for the case where Storage refused a file the page had
      already measured against a ceiling it turned out not to hold, so quoting
      that ceiling again would have been repeating the wrong number with
      confidence. Here the ceiling is the one that was actually applied, half a
      line above, so saying it is the useful thing rather than the dishonest one.
    */
    return refuse(
      413,
      "too-large",
      purpose === "reference"
        ? `That reference is ${formatBytes(bytes)}. We only read the first couple of minutes of one, so keep it under ${formatBytes(maxBytes)}. A short clip in the style you want is plenty.`
        : `"${filename}" is ${formatBytes(bytes)}. Keep it under ${formatBytes(maxBytes)}.`,
    );
  }

  if (context.quota && context.quota.used >= context.quota.allowed) {
    /*
      Counted before the upload rather than after it.

      Both of these limits already existed and both were enforced at the moment
      the finished object was registered, which is to say after somebody had
      already waited for the bytes to go. Refusing here costs them nothing and
      is the same answer.
    */
    return refuse(
      409,
      "quota",
      `You can keep ${context.quota.allowed} ${context.quota.noun}. Remove one to add another.`,
    );
  }

  const key = keyFor(purpose, context, request.projectId ?? "", extension, context.stamp);
  /*
    The last gate, and it should never fire.

    Every part of this key is either a verified user id, a fixed word, a
    generated stamp or an extension already narrowed to five lowercase
    alphanumerics. The project id is the one segment that arrives from the
    request, and the route has already found a row with it. So this is a
    belt-and-braces check against a future caller that skips that lookup, and
    it is the same rule the object store enforces at the door, imported rather
    than restated: a guard that exists in two spellings is one refactor away
    from existing in one.
  */
  if (!isSafeKey(key)) {
    return refuse(400, "unsafe-key", "That upload could not be given a place to live.");
  }

  return { ok: true, plan: { key, contentType, maxBytes } };
}

/** Whether this file is large enough that starting again from zero would hurt. */
export function worthResuming(bytes: number): boolean {
  return bytes > RESUMABLE_ABOVE_BYTES;
}
