/**
 * Turns what someone typed into an edit plan the worker can actually execute.
 *
 * This is not AI, and it does not pretend to be. It is a keyword matcher over
 * the four operations that exist — which is exactly what the old version was,
 * except that one replied "I'll throw in some dynamic zooms" to a system with
 * no zoom operation, and then rendered nothing at all.
 *
 * The important property here is that the reply is derived from the plan, so it
 * cannot promise something the plan does not contain. When phase 4 puts a real
 * model behind this, the model's job is to emit one of these plans; everything
 * downstream stays as it is.
 */
import type { EditOperation, Platform } from "@workspace/api-zod";

export interface ParsedIntent {
  operations: EditOperation[];
  /** What we understood and will do, phrased for the user. */
  willDo: string[];
  /** Things they asked for that we recognise but cannot do yet. */
  cannotYet: string[];
}

const PLATFORM_WORDS: Array<{ platform: Platform; patterns: RegExp }> = [
  { platform: "tiktok", patterns: /\btiktok|tik tok\b/i },
  { platform: "reels", patterns: /\breels?|instagram|insta\b/i },
  { platform: "shorts", patterns: /\bshorts?|youtube|yt\b/i },
];

/** Asked-for things that are real product ideas but have no operation yet. */
const NOT_YET: Array<{ patterns: RegExp; label: string }> = [
  { patterns: /\bcaption|subtitle|text on screen\b/i, label: "burn in captions (needs transcription, coming next)" },
  { patterns: /\bzoom|punch in\b/i, label: "add zooms" },
  { patterns: /\bemoji/i, label: "add emojis" },
  { patterns: /\bmusic|beat|sound ?track\b/i, label: "add music or sync to a beat" },
  { patterns: /\bcolou?r|grade|cinematic|filter\b/i, label: "colour grade" },
  { patterns: /\bhook|first (two|2|three|3) seconds\b/i, label: "build a hook from the opening" },
  { patterns: /\bb-?roll\b/i, label: "cut in B-roll" },
  { patterns: /\btransition/i, label: "add transitions" },
];

const SILENCE_WORDS =
  /\bsilence|silent|quiet|pause|dead air|um+s?\b|\bfiller|tighten|trim|short|fast|snapp|pace|boring|drag/i;

const VERTICAL_WORDS = /\bvertical|9:16|portrait|full ?screen\b/i;

export function planFromText(text: string, options: { defaultPlatform?: Platform | null } = {}): ParsedIntent {
  const operations: EditOperation[] = [];
  const willDo: string[] = [];
  const cannotYet: string[] = [];

  const wantsSilenceCut = SILENCE_WORDS.test(text);
  const platform = PLATFORM_WORDS.find((p) => p.patterns.test(text))?.platform ?? null;
  const wantsVertical = platform !== null || VERTICAL_WORDS.test(text);

  if (wantsSilenceCut) {
    operations.push({ type: "removeSilence", thresholdDb: -32, minSilenceMs: 500, paddingMs: 80 });
    willDo.push("cut out the silences and dead air");
  }

  if (wantsVertical) {
    const target = platform ?? options.defaultPlatform ?? "tiktok";
    operations.push({ type: "formatForPlatform", platform: target });
    willDo.push(`reframe it to 9:16 for ${target}`);
  }

  for (const { patterns, label } of NOT_YET) {
    if (patterns.test(text)) cannotYet.push(label);
  }

  return { operations, willDo, cannotYet };
}

/**
 * The assistant's reply. Written from the parsed plan so it can only claim what
 * the worker will really do — and says plainly when it cannot do something.
 */
export function replyFor(intent: ParsedIntent, context: { hasVideo: boolean }): string {
  if (!context.hasVideo) {
    return "Upload a video first and I'll get to work — I can cut the silences out and reframe it for TikTok, Reels or Shorts.";
  }

  const parts: string[] = [];

  if (intent.willDo.length > 0) {
    parts.push(`Right — I'll ${joinNaturally(intent.willDo)}. Hit Generate Edit and I'll start.`);
  }

  if (intent.cannotYet.length > 0) {
    parts.push(
      `I can't ${joinNaturally(intent.cannotYet)} yet, so I'll leave ${intent.cannotYet.length > 1 ? "those" : "that"} out rather than pretend.`,
    );
  }

  if (parts.length === 0) {
    return (
      "I'm not sure what to change from that. Right now I can cut the silences out of a clip " +
      "and reframe it to 9:16 for TikTok, Reels or Shorts — try something like " +
      '"remove the dead air and make it vertical for TikTok".'
    );
  }

  return parts.join(" ");
}

function joinNaturally(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
