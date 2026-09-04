/**
 * Deciding whether a font somebody uploaded can be used, and what its numbers
 * are.
 *
 * The picker offers thirteen faces we chose, measured and repaired by hand.
 * This is the same thing done to a file we have never seen, on the machine
 * that will burn with it — because everything the catalogue's comment says
 * about being silently wrong is *more* true of a font nobody vetted, not less.
 *
 * ## Why a font cannot simply be accepted
 *
 * Four things go wrong, and not one of them fails:
 *
 * **It does not resolve.** libass asks fontconfig for a family; a family that
 * is not there is not an error. fontconfig substitutes, the caption draws, the
 * words and timing are right, and every caption is in DejaVu Sans. Measured, a
 * style naming a font that does not exist renders byte-identically to one
 * naming the fallback — so the only way to know a face was used is to prove
 * the frame *differs* from the frame the fallback draws.
 *
 * **Its ratio is unknown.** ASS `Fontsize` is the line height, and the
 * fraction of it a letter occupies is a property of the face: 0.31 to 0.57
 * across the thirteen we ship. Assume a number and every caption in that face
 * is the wrong size, on a font the person chose themselves, with nothing
 * failing anywhere.
 *
 * **Its width is unknown.** The layout wraps against a per-character advance
 * table measured from one face. A face that runs 40% narrower wraps a third
 * early; one that runs wider pushes the last word of a sentence under the
 * username, off the safe area, where it is cropped by the platform and not by
 * us.
 *
 * **It cannot draw the script it claims.** This is the Rubik case, and it is
 * the reason this file measures a *word* and not a row of letters. Rubik
 * covers Arabic, resolves, measures a sane ratio, draws every isolated form —
 * and renders a box for لا, because it has no lam-alef ligature glyph for
 * plain alef and FriBidi asks for U+FEFB by codepoint. Every height-based
 * check passed it.
 *
 * So each of the four is measured here, on real frames, before a face is ever
 * offered to a render. A face that fails one is refused with the reason, in
 * both languages, because "your font was rejected" is not something a person
 * can act on.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FaceScript } from "@workspace/api-zod/fonts";
import { guard, LIMITS } from "./deadline.js";

/** What a measured face is worth to the catalogue. */
export interface FaceMeasurement {
  capRatio: number;
  widthScale: number;
}

export type RefusalCode =
  | "doesNotResolve"
  | "drawsNothing"
  | "cannotDrawTheScript"
  | "ratioOutOfRange"
  | "wrongScript";

export interface Refusal {
  code: RefusalCode;
  /** What was measured, for the log. Never shown to a person. */
  detail: string;
  /** What a person is told, in the language they are using. */
  english: string;
  arabic: string;
}

export type IntakeResult =
  | ({ ok: true } & FaceMeasurement)
  | { ok: false; refusal: Refusal };

/*
  A face nothing can satisfy.

  Every "did this resolve" question is really "is this frame different from the
  frame fontconfig draws when it is given nothing it knows", and that needs a
  name no font on any machine will ever answer to.
*/
const NO_SUCH_FAMILY = "EditlyNoSuchFamily-9f3c";

const SIZE = 100;
const W = 500;
const H = 500;
const WIDE = 3600;

/** What each script is measured with. See `tools/font-test.mjs` for the rest. */
const CAPS = "HANDLING";
const ALEFS = "ا".repeat(14);
const WORDS: Record<FaceScript, string[]> = {
  latin: ["the quick brown fox jumps over a lazy dog", "NOBODY TELLS YOU THIS BUT IT CHANGES"],
  arabic: ["لكنه يغير كل شيء عن الطريقة التي تحرر بها", "محمد سعيد ابراهيم شمس"],
};

/**
 * The face the advance table was measured from, per script, and where it is.
 *
 * Measured live rather than written down as a constant. A constant here would
 * be a number nobody re-derives, drifting the moment either reference face is
 * rebuilt — and drifting *quietly*, since the only symptom is captions that
 * wrap in the wrong place. Four extra ffmpeg runs on an upload is nothing; an
 * upload is not a hot path, and this is the one moment a font's numbers are
 * ever decided.
 */
const REFERENCE: Record<FaceScript, string> = {
  latin: "Montserrat Black",
  arabic: "Cairo Black",
};

/** Where the faces this image ships live, which is where the references are. */
const SHIPPED_FONTS = process.env.EDITLY_FONT_DIR ?? "/usr/share/fonts/truetype/editly";

function ink(buffer: Buffer, width: number, height: number) {
  let count = 0;
  let top = -1;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (buffer[row + x] > 40) {
        count += 1;
        if (top < 0) top = y;
        bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  return {
    ink: count,
    w: right < 0 ? 0 : right - left + 1,
    h: top < 0 ? 0 : bottom - top + 1,
    /*
      Pixel count at width by height, which is what makes "is this the same
      glyph" answerable. Two runs of the same `.notdef` box agree to the pixel;
      two different glyphs do not. A height comparison cannot tell them apart —
      in Cairo a lam-alef ligature and a box are both 38 tall — and that is
      exactly how a font that could not draw لا passed the suite.
    */
    signature: `${count}:${right < 0 ? 0 : right - left + 1}x${top < 0 ? 0 : bottom - top + 1}`,
  };
}

/**
 * One frame's worth of grey, through libass.
 *
 * `alone` chooses which of two worlds the frame is drawn in, and the two
 * answer different questions.
 *
 * **Alone**: a fontconfig config naming `dir` and nothing else. Nothing can
 * fall back, so a codepoint the face does not map draws the face's own
 * `.notdef` box — a thing that can be recognised. This is where a face is
 * *measured*, and it is where the lam-alef question is asked, because on a
 * normal machine that question cannot be asked at all: measured on this image,
 * Rubik renders لا correctly, at DejaVu's proportions, from a file containing
 * no lam-alef shape. It looks right here and has a box in it on a machine
 * without that fallback — legible, wrong, and different on the reader's screen
 * from the one it was checked on, which is the failure this whole area exists
 * to prevent.
 *
 * **Not alone**: the machine's own fontconfig, plus `dir`. That is the world
 * the renderer runs in, and it is the only place the *other* question can be
 * asked — whether the family name resolves to this file at all. Alone, it
 * always does: with one font in the world, fontconfig returns it whatever it
 * was asked for, so a font nothing can address would measure perfectly and
 * then draw every caption in DejaVu.
 */
async function draw(
  dir: string,
  family: string,
  text: string,
  width: number,
  height: number,
  alone = true,
) {
  const work = await mkdtemp(path.join(tmpdir(), "editly-intake-"));
  try {
    const ass = path.join(work, "m.ass");
    await writeFile(
      ass,
      [
        "[Script Info]",
        "ScriptType: v4.00+",
        `PlayResX: ${width}`,
        `PlayResY: ${height}`,
        "WrapStyle: 2",
        "",
        "[V4+ Styles]",
        "Format: Name,Fontname,Fontsize,PrimaryColour,OutlineColour,BackColour,Bold,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
        // Bold on, because the renderer's style rows are bold and a face
        // fontconfig cannot satisfy gets synthesised weight — which changes the
        // answer. A measurement taken under different flags from the thing it
        // describes is a measurement of something else.
        `Style: P,${family},${SIZE},&H00FFFFFF,&H00000000,&H00000000,-1,1,0,0,5,10,10,10,1`,
        "",
        "[Events]",
        "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
        `Dialogue: 0,0:00:00.00,0:00:01.00,P,,0,0,0,,{\\an5\\pos(${width / 2},${height / 2})}${text}`,
        "",
      ].join("\n"),
      "utf8",
    );
    const escaped = ass.replace(/[\\:']/g, "\\$&");
    let conf: string | undefined;
    let filter = `subtitles=${escaped}:fontsdir=${dir.replace(/[\\:']/g, "\\$&")},format=gray`;
    if (alone) {
      conf = path.join(work, "fonts.conf");
      await writeFile(
        conf,
        [
          '<?xml version="1.0"?>',
          '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
          "<fontconfig>",
          `  <dir>${dir.replace(/[&<>"]/g, "")}</dir>`,
          // Its own cache, thrown away with the directory. fontconfig keys a
          // cache on a directory's path and mtime, and these directories are
          // temporary: a shared cache would accumulate one entry per upload,
          // for ever, describing folders that no longer exist.
          `  <cachedir>${work.replace(/[&<>"]/g, "")}</cachedir>`,
          "</fontconfig>",
          "",
        ].join("\n"),
        "utf8",
      );
      filter = `subtitles=${escaped},format=gray`;
    }
    const raw = await rawFrame(
      [
        "-v", "error",
        "-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:d=1`,
        "-vf", filter,
        "-frames:v", "1", "-f", "rawvideo", "-",
      ],
      conf,
    );
    if (raw.length < width * height) return { ink: 0, w: 0, h: 0, signature: "none" };
    return ink(raw, width, height);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** ffmpeg to stdout, on a leash. A font that hangs libass is a font, not a bug. */
function rawFrame(args: string[], fontconfig?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: fontconfig ? { ...process.env, FONTCONFIG_FILE: fontconfig } : process.env,
    });
    const deadline = guard(child, { ...LIMITS.probe, what: "ffmpeg (font intake)" });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      deadline.touch();
      chunks.push(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      deadline.touch();
      stderr += d.toString();
    });
    child.on("error", (err) => {
      deadline.clear();
      reject(err);
    });
    child.on("close", (code) => {
      deadline.clear();
      // Before the code, because a killed child closes like a finished one.
      if (deadline.expired) {
        reject(deadline.error);
        return;
      }
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().split("\n").slice(-2).join(" ")}`));
    });
  });
}

/**
 * How wide a face runs, per character, per unit of cap height.
 *
 * Divided by the cap height rather than the nominal size, because two faces at
 * the same `Fontsize` are not the same size on screen — that is the whole
 * reason `capRatio` exists — and comparing their widths without dividing it
 * out compares two different sizes.
 *
 * The widest of two samples, not the average: what the layout needs to not
 * overflow is the worst line, and a sentence of narrow letters would otherwise
 * talk the number down.
 */
async function widthPerCap(dir: string, family: string, capRatio: number, script: FaceScript) {
  let widest = 0;
  for (const text of WORDS[script]) {
    const line = await draw(dir, family, text, WIDE, 400);
    widest = Math.max(widest, line.w / [...text].length / (capRatio * SIZE));
  }
  return widest;
}

/**
 * Measure a repaired face, and refuse it if it cannot do the job.
 *
 * `dir` holds the font file and nothing else that matters; `family` is the
 * name it was renamed to. Both come from the repair step, which is the only
 * thing that knows them.
 */
/**
 * How many letters of each script the repair found in the file's cmap.
 *
 * Counted by `prepare-user-font.py`, which already refuses a file with fewer
 * than twenty of either — a symbol or icon font, not a text one. Those numbers
 * came back through `Prepared` and **nobody read them**, which is how the most
 * ordinary mistake a person can make on this screen got the least useful answer
 * in the file. See `intakeFace`'s first step.
 */
export interface Coverage {
  arabic: number;
  latin: number;
}

/** Below this, a font does not have the script — the same line the repair draws. */
const ENOUGH_LETTERS = 20;

export async function intakeFace(
  dir: string,
  family: string,
  script: FaceScript,
  coverage?: Coverage,
): Promise<IntakeResult> {
  const sample = script === "arabic" ? ALEFS : CAPS;

  /*
    0. Is this the script the person filed it under?

    Asked first, and asked from the cmap rather than from a frame, because
    every question below it is asked by drawing — and a font with no Arabic in
    it draws Arabic exactly the way a font with a broken name does: fontconfig
    substitutes, the frame matches the fallback's, and step 2 answers
    "doesNotResolve". So somebody who uploaded a perfectly good Latin display
    face under the Arabic heading — the single most likely mistake on that
    screen, since the two boxes sit side by side — was told *the family name
    inside the file is not one the renderer can be asked for*. That sentence is
    true of a different font and there is nothing they can do with it. They
    have a working font and a message about metadata.

    The numbers to answer it properly were already being computed, returned by
    the repair step, and read by nothing.
  */
  if (coverage) {
    const has = script === "arabic" ? coverage.arabic : coverage.latin;
    const other = script === "arabic" ? coverage.latin : coverage.arabic;
    if (has < ENOUGH_LETTERS && other >= ENOUGH_LETTERS) {
      const isArabic = script === "arabic";
      return {
        ok: false,
        refusal: {
          code: "wrongScript",
          detail: `${family} has ${coverage.arabic} Arabic and ${coverage.latin} Latin letters, filed under ${script}`,
          english: isArabic
            ? "This font has no Arabic letters in it. It looks like a Latin font, so add it under the Latin heading instead and it will work."
            : "This font has no Latin letters in it. It looks like an Arabic font, so add it under the Arabic heading instead and it will work.",
          arabic: isArabic
            ? "هذا الخط لا يحتوي حروفًا عربية. يبدو أنه خطّ لاتيني، فأضفه تحت العنوان اللاتيني وسيعمل."
            : "هذا الخط لا يحتوي حروفًا لاتينية. يبدو أنه خطّ عربي، فأضفه تحت العنوان العربي وسيعمل.",
        },
      };
    }
  }

  // 1. Does anything come out at all — asked where the renderer runs, because
  //    the next question can only be asked there and both want the same frame.
  const drawn = await draw(dir, family, sample, W, H, false);
  if (drawn.ink === 0) {
    return {
      ok: false,
      refusal: {
        code: "drawsNothing",
        detail: `${family} drew no ink for the sample`,
        english: "This font file draws nothing at all. The letters in it have no shapes, or the file is a stub.",
        arabic: "هذا الملف لا يرسم شيئًا. الحروف فيه بلا أشكال، أو الملف ناقص.",
      },
    };
  }

  // 2. Is it *this* font, or is it fontconfig's fallback wearing its name.
  const fallback = await draw(dir, NO_SUCH_FAMILY, sample, W, H, false);
  if (drawn.signature === fallback.signature) {
    return {
      ok: false,
      refusal: {
        code: "doesNotResolve",
        detail: `${family} renders identically to the fallback (${drawn.signature})`,
        english:
          "The file loaded, but nothing on the frame came from it: the renderer fell back to its own font. The family name inside the file is not one it can be asked for.",
        arabic:
          "حُمّل الملف، لكن لا شيء على الإطار جاء منه: رجع المحرّك إلى خطّه الخاص. اسم العائلة داخل الملف ليس اسمًا يمكن طلبه به.",
      },
    };
  }

  // 3. The ratio, which is what turns a height in pixels into a Fontsize.
  //    From the isolated frame: a height that another font contributed to is
  //    a measurement of two fonts.
  const alone = await draw(dir, family, sample, W, H);
  const capRatio = Number((alone.h / SIZE).toFixed(2));
  if (capRatio < 0.15 || capRatio > 0.9) {
    return {
      ok: false,
      refusal: {
        code: "ratioOutOfRange",
        detail: `${family} measured ${capRatio}, outside 0.15..0.9`,
        english:
          "The letters in this font are an extreme fraction of its line height, so captions in it cannot be sized to match the rest. It is probably an icon or symbol font rather than a text one.",
        arabic:
          "الحروف في هذا الخط تشغل نسبة شاذّة من ارتفاع السطر، فلا يمكن ضبط حجم الكابشن به ليطابق البقيّة. غالبًا هو خط أيقونات أو رموز لا خط نصّ.",
      },
    };
  }

  // 4. A word, not a row of letters. The check that catches the Rubik case.
  const probe = script === "arabic" ? "لا" : "Wag";
  /*
    One box per glyph the probe becomes, and the count is not the count of
    characters.

    FriBidi turns lam+alef into a single U+FEFB ligature, so "لا" is *one*
    glyph on the frame — a ligature if the face has one, a `.notdef` box if it
    does not. Comparing it against two boxes compares one shape to two, which
    can never match, and the check passes everything. That is not a
    hypothetical: it passed Rubik, the one font in this repository that exists
    to be caught by it.

    Boxes drawn in the face itself, because a `.notdef` box is a glyph of the
    file being measured and its size is that file's, not another font's.
  */
  const glyphs = script === "arabic" ? 1 : [...probe].length;
  const wordInk = await draw(dir, family, probe, W, H);
  const boxes = await draw(dir, family, "\uE000\uE001\uE002".slice(0, glyphs), W, H);
  if (wordInk.ink === 0 || wordInk.signature === boxes.signature) {
    return {
      ok: false,
      refusal: {
        code: "cannotDrawTheScript",
        detail: `${family} drew "${probe}" as ${wordInk.signature}, boxes are ${boxes.signature}`,
        english:
          script === "arabic"
            ? "This font cannot draw لا. It has no lam-alef shape, so real Arabic sentences would come out with empty boxes in them. It can still be used for English."
            : "This font cannot draw ordinary Latin words: letters in it come out as empty boxes.",
        arabic:
          script === "arabic"
            ? "هذا الخط لا يرسم «لا»: لا يملك شكل اللام-ألف، فتخرج الجُمل العربية الحقيقية وفيها مربّعات فارغة. ما زال صالحًا للإنجليزية."
            : "هذا الخط لا يرسم الكلمات اللاتينية العادية: تخرج حروفه مربّعات فارغة.",
      },
    };
  }

  // 5. The width, measured the same way the catalogue's numbers were — and
  //    against the same reference face, re-measured here rather than recalled.
  const reference = REFERENCE[script];
  const referenceRatio = (await draw(SHIPPED_FONTS, reference, sample, W, H)).h / SIZE;
  const widest = await widthPerCap(dir, family, capRatio, script);
  const baseline = await widthPerCap(SHIPPED_FONTS, reference, referenceRatio, script);
  if (!(baseline > 0)) {
    /*
      The references are in the image, so this is not a font problem — it is
      this worker's own fonts being missing, and answering an upload with a
      number derived from nothing would write a wrong width into the catalogue
      for good. Refusing is recoverable; a bad number is not.
    */
    return {
      ok: false,
      refusal: {
        code: "doesNotResolve",
        detail: `the reference face ${reference} drew nothing from ${SHIPPED_FONTS}`,
        english: "Something is wrong on our side, not with your font. Try again in a few minutes.",
        arabic: "الخلل عندنا لا في خطّك. جرّب مرة أخرى بعد دقائق.",
      },
    };
  }
  /*
    Rounded up, and the asymmetry is deliberate. A scale that is too small runs
    a line past the platform's safe area, where the last word sits under the
    username and is cropped by somebody else. A scale that is too large costs a
    line break. Those two do not cost the same.
  */
  const widthScale = Math.max(0.3, Math.ceil((widest / baseline) * 20) / 20);

  return { ok: true, capRatio, widthScale };
}
