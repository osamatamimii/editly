/**
 * Turning an uploaded font file into a face the picker can offer.
 *
 * This is the sweep, not the judgement. What makes a font usable and what its
 * numbers are is `font-intake.ts`; what repairs it is
 * `fonts/prepare-user-font.py`. This file is the part that notices a row is
 * waiting, does those two things to it, and writes down what happened.
 *
 * ## Why it runs beside the render loop and not behind it
 *
 * The same reason the scheduled-post sweep does. This process is
 * single-threaded and a render takes minutes; a font uploaded while one is
 * running would sit untouched until that render finished. The person who
 * uploaded it is *looking at the screen* — it is the most attended-to
 * ten seconds in the product — so the wait has to be bounded by the poll
 * interval and not by the longest job in the queue.
 *
 * ## Why a row is the queue
 *
 * `caption_faces.status = 'pending'` is already the fact that work is
 * outstanding, and a second table saying the same thing is a second thing that
 * can disagree with it. The claim is the ordinary one — an update that moves
 * the row out of `pending` and returns it, so two workers cannot both take it.
 */
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { db, captionFacesTable, type CaptionFaceRow } from "@workspace/db";
import type { CaptionFace, FaceScript } from "@workspace/api-zod/fonts";
import { asCaptionFace } from "./caption-layout.js";
import { downloadObject, uploadObject } from "./storage.js";
import { intakeFace } from "./font-intake.js";
import { guard, LIMITS } from "./deadline.js";

/**
 * What this file says out loud.
 *
 * A function rather than a logger, and the caller supplies it. This module is
 * called from the worker loop, which has a logger already carrying the
 * worker's id, and from the suites, which want the lines in the test output —
 * so it takes one instead of making a second one that would log under a
 * different name than everything around it.
 */
export type Say = (fields: Record<string, unknown>, message: string) => void;

const QUIET: Say = () => {};

/** How many wait rows one sweep takes. A person uploads a handful, not a folder. */
const PER_SWEEP = 4;

/**
 * Where the repair script is.
 *
 * Beside the bundle, which is where `build.mjs` copies it and where
 * `subject.ts` resolves its own Python from — one convention rather than two.
 * The environment variable is for running the worker from a checkout, where
 * there is no bundle and the script is still in `fonts/`.
 */
const SCRIPT = path.join(
  process.env["EDITLY_FONT_SCRIPTS"] ?? path.dirname(fileURLToPath(import.meta.url)),
  "prepare-user-font.py",
);

interface Prepared {
  ok: boolean;
  code?: string;
  detail?: string;
  family?: string;
  declared?: string;
  file?: string;
  preview?: string | null;
  arabicGlyphs?: number;
  latinGlyphs?: number;
  bytes?: number;
}

/**
 * The repair, as a subprocess, with a ceiling on it.
 *
 * fontTools is Python and the repair is not being rewritten in JavaScript to
 * avoid a process — that would be a second copy of the one thing this codebase
 * insists there is one of. The ceiling is `probe`'s: a font that takes two
 * minutes to parse is a font that would take two minutes inside every render.
 */
function repair(source: string, faceDir: string, previewDir: string, id: string): Promise<Prepared> {
  return new Promise((resolve) => {
    const child = spawn(process.env["PYTHON_PATH"] ?? "python3", [
      SCRIPT, source, faceDir, previewDir, "--id", id,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const deadline = guard(child, { ...LIMITS.probe, what: "prepare-user-font.py" });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => { deadline.touch(); out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { deadline.touch(); err += d.toString(); });
    child.on("error", (error) => {
      deadline.clear();
      resolve({ ok: false, code: "cannotRun", detail: error.message });
    });
    child.on("close", () => {
      deadline.clear();
      // Before parsing: a killed child closes like a finished one and would
      // otherwise be read as a font that simply printed nothing.
      if (deadline.expired) {
        resolve({ ok: false, code: "tookTooLong", detail: deadline.error?.message ?? "stopped" });
        return;
      }
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() ?? "") as Prepared);
      } catch {
        resolve({ ok: false, code: "unreadable", detail: (err || out).trim().split("\n").slice(-2).join(" ") });
      }
    });
  });
}

/**
 * What a person is told when the repair itself said no.
 *
 * The intake writes its own refusals in both languages, because it is the one
 * that knows what it measured. These are the ones from before there was
 * anything to measure — a file that is not a font, a font with no letters in
 * it — and they are here rather than in the Python because the Python's job is
 * to say what happened, not to phrase it for a reader.
 */
const REPAIR_REFUSALS: Record<string, { en: string; ar: string }> = {
  unreadable: {
    en: "This file is not a font, or it is damaged. Nothing could be read out of it.",
    ar: "هذا الملف ليس خطًّا، أو أنه تالف. لم يُقرأ منه شيء.",
  },
  noOutlines: {
    en: "The file has no letter shapes in it at all.",
    ar: "الملف لا يحتوي أشكال حروف إطلاقًا.",
  },
  noCmap: {
    en: "The font maps no characters, so nothing typed would reach a shape in it.",
    ar: "الخط لا يربط أي حرف بشكل، فلا شيء تكتبه يصل إلى شكل فيه.",
  },
  noLetters: {
    en: "This looks like an icon or symbol font rather than one with letters in it.",
    ar: "يبدو أنه خط أيقونات أو رموز لا خط حروف.",
  },
  tooLarge: {
    en: "This font file is too big. Fonts this product can burn with are a few megabytes at most.",
    ar: "ملف الخط كبير جدًّا. الخطوط التي يمكن الحرق بها بضعة ميغابايت على الأكثر.",
  },
  empty: { en: "The file is empty.", ar: "الملف فارغ." },
  tookTooLong: {
    en: "Reading this font took too long, so it was stopped. A font that slow would slow down every render made with it.",
    ar: "قراءة هذا الخط استغرقت وقتًا طويلًا فأُوقفت. خط بهذا البطء سيُبطئ كل فيديو يُصنع به.",
  },
};

const FALLBACK_REFUSAL = {
  en: "This font could not be prepared. If it opens in other programs, tell us and we will look.",
  ar: "تعذّر تجهيز هذا الخط. إن كان يعمل في برامج أخرى فأخبرنا وسنفحصه.",
};

async function refuse(say: Say, id: string, code: string, detail: string) {
  const said = REPAIR_REFUSALS[code] ?? FALLBACK_REFUSAL;
  await db
    .update(captionFacesTable)
    .set({
      status: "refused",
      refusalCode: code,
      refusalEn: said.en,
      refusalAr: said.ar,
      updatedAt: new Date(),
    })
    .where(eq(captionFacesTable.id, id));
  say({ face: id, code, detail }, "an uploaded font was refused");
}

/**
 * Claim one waiting row.
 *
 * `status` is the claim. Moving it to `preparing` in the same statement that
 * selects it is what stops a second worker taking the same font — and a row
 * left in `preparing` by a worker that died is picked up again by the age
 * clause, which is the same shape the render queue uses for a stale lock.
 */
async function claim() {
  const rows = await db.execute(sql`
    UPDATE caption_faces
       SET status = 'preparing', updated_at = now()
     WHERE id = (
       SELECT id FROM caption_faces
        WHERE status = 'pending'
           OR (status = 'preparing' AND updated_at < now() - interval '10 minutes')
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING id, user_id, script, source_path, label
  `);
  return (rows.rows[0] ?? null) as
    | { id: string; user_id: string; script: string; source_path: string; label: string }
    | null;
}

async function prepareOne(
  say: Say,
  row: { id: string; user_id: string; script: string; source_path: string },
): Promise<void> {
  const work = await mkdtemp(path.join(tmpdir(), "editly-face-"));
  try {
    const source = path.join(work, "uploaded");
    await downloadObject(row.source_path, source);

    /*
      Two directories, and it is not tidiness. The preview is a subset carrying
      the same family name as the full face; in one directory fontconfig
      indexes both and libass sometimes picks the subset, after which every
      character outside the sample renders as nothing at all.
    */
    const faceDir = path.join(work, "face");
    const previewDir = path.join(work, "preview");
    await mkdir(faceDir, { recursive: true });
    await mkdir(previewDir, { recursive: true });

    const prepared = await repair(source, faceDir, previewDir, row.id);
    if (!prepared.ok || !prepared.family || !prepared.file) {
      await refuse(say, row.id, prepared.code ?? "unreadable", prepared.detail ?? "");
      return;
    }

    const script = row.script as FaceScript;
    const verdict = await intakeFace(faceDir, prepared.family, script);
    if (!verdict.ok) {
      await db
        .update(captionFacesTable)
        .set({
          status: "refused",
          refusalCode: verdict.refusal.code,
          refusalEn: verdict.refusal.english,
          refusalAr: verdict.refusal.arabic,
          declared: prepared.declared ?? null,
          updatedAt: new Date(),
        })
        .where(eq(captionFacesTable.id, row.id));
      say(
        { face: row.id, code: verdict.refusal.code, detail: verdict.refusal.detail },
        "an uploaded font was measured and refused",
      );
      return;
    }

    const facePath = `${row.user_id}/fonts/${row.id}.ttf`;
    // The repaired face is always TrueType, whatever came in: `to_truetype`
    // converts CFF outlines on the way through. See `facerepair.py`.
    await uploadObject(path.join(faceDir, prepared.file), facePath, "font/ttf");
    let previewPath: string | null = null;
    if (prepared.preview) {
      previewPath = `${row.user_id}/fonts/${row.id}.woff2`;
      await uploadObject(path.join(previewDir, prepared.preview), previewPath, "font/woff2");
    }

    await db
      .update(captionFacesTable)
      .set({
        status: "ready",
        family: prepared.family,
        declared: prepared.declared ?? null,
        facePath,
        previewPath,
        capRatio: verdict.capRatio,
        widthScale: verdict.widthScale,
        bytes: prepared.bytes ?? 0,
        refusalCode: null,
        refusalEn: null,
        refusalAr: null,
        updatedAt: new Date(),
      })
      .where(eq(captionFacesTable.id, row.id));

    say(
      { face: row.id, family: prepared.family, capRatio: verdict.capRatio, widthScale: verdict.widthScale },
      "an uploaded font is ready",
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** One pass. Returns how many were dealt with, so the loop can say so. */
export async function prepareUploadedFaces(say: Say = QUIET): Promise<number> {
  let done = 0;
  for (let i = 0; i < PER_SWEEP; i += 1) {
    const row = await claim();
    if (!row) break;
    try {
      await prepareOne(say, row);
    } catch (error) {
      /*
        Anything unexpected — storage down, the file gone, a font that crashes
        fontTools in a way it does not catch — leaves a row that would sit in
        `preparing` for ever and a person watching a spinner that never stops.
        A refusal they can retry is a better end than silence.
      */
      await refuse(say, row.id, "cannotPrepare", error instanceof Error ? error.message : String(error));
    }
    done += 1;
  }
  return done;
}

/**
 * Every ready face this person owns, in the shape the renderer's catalogue
 * uses. One list, so the picker and a plan cannot disagree about what exists.
 */
export async function readyFacesFor(userId: string): Promise<CaptionFaceRow[]> {
  return db
    .select()
    .from(captionFacesTable)
    .where(and(eq(captionFacesTable.userId, userId), eq(captionFacesTable.status, "ready")));
}

/**
 * The faces a plan names, downloaded next to the render that will use them.
 *
 * Only the ones it names: a person with twenty uploaded fonts should not wait
 * for twenty downloads to render a caption in one of them. Returns undefined
 * when the plan names none, so the render's filter graph stays exactly the
 * string it was before this feature existed.
 *
 * A face that will not download is dropped with a line in the log rather than
 * failing the job — `faceById` falls back to the default, which is a caption
 * in the wrong font instead of a render that dies at its last step.
 */
export async function fetchUploadedFaces(
  userId: string,
  wanted: readonly (string | null | undefined)[],
  workDir: string,
  say: Say = QUIET,
): Promise<{ available: CaptionFace[]; dir: string } | undefined> {
  const ids = [...new Set(wanted.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return undefined;

  const rows = (await readyFacesFor(userId)).filter((row) => ids.includes(row.id));
  if (rows.length === 0) return undefined;

  const dir = path.join(workDir, "fonts");
  await mkdir(dir, { recursive: true });
  const available: CaptionFace[] = [];
  for (const row of rows) {
    if (!row.facePath || !row.family) continue;
    try {
      await downloadObject(row.facePath, path.join(dir, `${row.id}.ttf`));
      available.push(asCaptionFace(row));
    } catch (error) {
      say({ face: row.id, err: String(error) }, "could not fetch an uploaded font; using the default face");
    }
  }
  return available.length > 0 ? { available, dir } : undefined;
}
