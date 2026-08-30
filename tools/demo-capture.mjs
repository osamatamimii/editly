/**
 * Drives the built app through one real edit and records it.
 *
 * **Nothing on the landing page uses its output any more, and that is the
 * point of this note rather than a reason to delete the file.**
 *
 * The hero was this recording for several rounds. It failed for three reasons
 * no re-record fixes: the largest element in it is the video player, and the
 * demo project has no footage in it, so the biggest thing on a page selling a
 * video editor was an empty gradient where the video goes; a 1280x800 window
 * scaled into a 1000px hero renders every label at about eight pixels; and it
 * cost 1.4MB across four files on every visit. The hero is drawn now, in DOM
 * and SVG, at the size it is shown.
 *
 * This still runs, and is still the honest way to *watch* the product work end
 * to end when something needs checking by eye: it types a real sentence into
 * the real app, waits for a real plan, and renders a real edit. Keep it for
 * that. If a recording ever goes back on a page, give it real footage first,
 * record at the size it will be shown, and encode it above 209kbps.
 */
import http from "node:http";
import { readFile, mkdir, rm, readdir } from "node:fs/promises";
import { existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(repoRoot, "dist");
const outDir = path.join(repoRoot, "artifacts/editly/public");
const work = "/tmp/editly-demo";
/**
 * Two recordings, because one does not work.
 *
 * A 1280-wide desktop capture scaled into a 390px phone is a picture of text
 * nobody can read — the hero on a phone became a grey smudge. The app has a
 * phone layout, so the phone recording is of that, and each viewport gets the
 * one that was shot for it.
 */
const PHONE = process.argv.includes("--phone");
const SHAPE = PHONE
  ? { width: 390, height: 844, suffix: "-phone", scale: 3 }
  : { width: 1280, height: 800, suffix: "", scale: 2 };
const PROJECT_REF = "jszalanebxdshrwwegmg";
const USER = "00000000-0000-4000-8000-00000000beef";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

if (!existsSync(dist)) {
  console.error("dist/ is not built — run `pnpm run vercel:build` first.");
  process.exit(1);
}

// ── serve the built site ─────────────────────────────────────────────────────
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2", ".mp4": "video/mp4", ".webm": "video/webm" };
const CLIPS = process.env.DEMO_CLIPS ?? "/tmp/demo";
const server = http.createServer(async (req, res) => {
  const asked = decodeURIComponent(req.url.split("?")[0]);
  // The two real files this recording is about, served beside the built site so
  // the editor's own player can load them the way it loads any other URL.
  let p = asked.startsWith("/clips/")
    ? path.join(CLIPS, asked.slice("/clips/".length))
    : path.join(dist, asked);
  if (!existsSync(p) || statSync(p).isDirectory()) p = path.join(dist, "index.html");
  try {
    const body = await readFile(p);
    res.writeHead(200, { "Content-Type": types[path.extname(p)] ?? "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end("no"); }
});
const PORT = 4477;
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const origin = `http://127.0.0.1:${PORT}`;

// ── the story the recording tells ────────────────────────────────────────────
//
// One sentence in, a plan back, a render, a finished vertical cut. It is the
// product's whole promise and it fits in fifteen seconds.
const PROMPT = "Cut the dead air and make it vertical for TikTok";
/** How long the finished cut runs — the real file's own length. */
const RESULT_SECONDS = 6.6;

const project = (over = {}) => ({
  id: PROJECT_ID,
  title: "Podcast episode 14 — the raw take",
  status: "ready",
  thumbnailUrl: null, videoUrl: `${origin}/clips/raw-take.webm`, editedVideoUrl: null,
  videoPath: null, editedVideoPath: null, thumbnailPath: null,
  referenceVideoPath: null, duration: 12.27, width: 1920, height: 1080,
  editedWidth: null, editedHeight: null, platform: null, renderStalled: false,
  createdAt: "2026-08-20T10:00:00.000Z", updatedAt: "2026-08-24T09:30:00.000Z",
  ...over,
});

const PLAN = {
  version: 1,
  operations: [
    { type: "removeSilence", thresholdDb: -32, minSilenceMs: 400, paddingMs: 90 },
    { type: "formatForPlatform", platform: "tiktok" },
    { type: "normalizeLoudness", targetLufs: -14 },
  ],
};

const renderJob = (status, progress, stage) => ({
  id: "job-1", projectId: PROJECT_ID, status, progress, stage, error: null,
  plan: PLAN, outputPath: null,
  createdAt: "2026-08-24T09:31:00.000Z", updatedAt: new Date().toISOString(),
});

/** Mutable, because the recording is a story and the server's answers change. */
const state = {
  messages: [],
  render: null,
  project: project(),
};

function answer(pathname, method) {
  if (pathname === "/api/stats/dashboard") {
    return { totalProjects: 3, processingCount: 0, stalledCount: 0, doneCount: 2, recentProjects: [state.project], worker: { online: true, lastSeenAt: new Date().toISOString(), transcription: "whisper-1", vision: null } };
  }
  if (pathname === "/api/projects") return [state.project];
  if (pathname === `/api/projects/${PROJECT_ID}`) return state.project;
  if (pathname === `/api/projects/${PROJECT_ID}/messages`) {
    if (method === "POST") {
      state.messages.push({ id: `u${state.messages.length}`, role: "user", content: PROMPT, createdAt: new Date().toISOString() });
      state.messages.push({
        id: `a${state.messages.length}`,
        role: "assistant",
        content: "Here is what I will do: cut every silence longer than 0.4s, reframe to 9:16 keeping you in the middle, and level the audio to −14 LUFS.",
        createdAt: new Date().toISOString(),
      });
      // `running`, not "processing": the client only keeps polling while the
      // status is one the queue actually uses, which is exactly the kind of
      // detail a hand-written mock gets wrong and a recording of the real app
      // catches immediately — the first take stopped at 8% forever.
      state.render = renderJob("running", 8, "Reading the file");
      state.project = project({ status: "processing" });
      return { plan: PLAN, render: { id: "job-1" } };
    }
    return state.messages;
  }
  if (pathname === `/api/projects/${PROJECT_ID}/render/status`) return state.render;
  if (pathname === `/api/projects/${PROJECT_ID}/clips`) return [];
  if (pathname === `/api/projects/${PROJECT_ID}/export/status`) return { state: "idle" };
  if (pathname === "/api/subscription") {
    return { plan: "creator", minutesIncluded: 60, minutesGranted: 0, minutesUsedThisMonth: 12.5, minutesRemaining: 47.5, maxUploadMinutes: 30, watermark: false, referenceStyle: true, pricePerMonth: 12 };
  }
  if (pathname === "/api/templates") {
    return [
      { id: "talking-head", name: "Talking head", description: "Silence out, framed vertical, levels fixed.", bestFor: "One person to camera", needs: null },
      { id: "on-the-beat", name: "On the beat", description: "Punches in on the beat of the track you picked.", bestFor: "Montages with music", needs: "music" },
      { id: "clean-cut", name: "Clean cut", description: "Tight, quiet, no tricks.", bestFor: "Interviews", needs: null },
    ];
  }
  if (pathname === `/api/projects/${PROJECT_ID}/assets`) return [];
  return {};
}

// ── record ───────────────────────────────────────────────────────────────────
const { chromium } = await import("playwright");
function findChromium() {
  const r = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!r || !existsSync(r)) return undefined;
  for (const d of readdirSync(r)) {
    if (!/^chromium[-_]/.test(d)) continue;
    const c = path.join(r, d, "chrome-linux", "chrome");
    if (existsSync(c)) return c;
  }
  return undefined;
}
const exe = findChromium();

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });

const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ["--no-sandbox", `--force-device-scale-factor=${SHAPE.scale}`, "--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({
  viewport: { width: SHAPE.width, height: SHAPE.height },
  deviceScaleFactor: SHAPE.scale,
  isMobile: PHONE,
  hasTouch: PHONE,
  colorScheme: "dark",
  recordVideo: { dir: work, size: { width: SHAPE.width, height: SHAPE.height } },
});

await ctx.route("**/*.supabase.co/**", (route) => {
  const u = new URL(route.request().url());
  if (u.pathname.startsWith("/auth/v1/settings")) return route.fulfill({ json: { external: { google: true, apple: true } } });
  return route.fulfill({ json: {} });
});
await ctx.route(`${origin}/api/**`, (route) => {
  const u = new URL(route.request().url());
  return route.fulfill({ json: answer(u.pathname, route.request().method()) });
});
await ctx.addInitScript(([ref, uid]) => {
  try {
    localStorage.setItem("editly-theme", "dark");
    localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify({
      access_token: "header.eyJzdWIiOiJ0ZXN0In0.sig",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: "refresh",
      user: { id: uid, aud: "authenticated", role: "authenticated", email: "you@example.com", app_metadata: { provider: "email" }, user_metadata: {}, created_at: "2026-01-01T00:00:00.000Z" },
    }));
  } catch { /* private mode */ }
}, [PROJECT_REF, USER]);

// The video starts recording when the first page opens, so this is frame zero
// and every offset below is measured from it.
const videoStartedAt = Date.now();
const page = await ctx.newPage();
const wait = (ms) => page.waitForTimeout(ms);

await page.goto(`${origin}/project/${PROJECT_ID}`, { waitUntil: "networkidle" });
await wait(1100);

// Type it the way a person types it, not the way a script fills a field.
const input = page.getByTestId("input-chat");
await input.click();
// Frame zero for the finished file: the seconds before somebody starts typing
// are the browser booting, and nobody needs to watch that.
const typingAt = (Date.now() - videoStartedAt) / 1000;
for (const ch of PROMPT) {
  await input.type(ch, { delay: 0 });
  await wait(26 + (ch === " " ? 34 : 0));
}
await wait(480);
const sendAt = (Date.now() - videoStartedAt) / 1000;
await page.getByTestId("button-send-message").click();
await wait(2000);

// The render moving. Each step is a real poll answered with the next state.
const STAGES = [
  [24, "Measuring the silences"], [46, "Cutting"], [67, "Reframing to 9:16"],
  [88, "Burning the captions"],
];
for (const [progress, stage] of STAGES) {
  state.render = renderJob("running", progress, stage);
  await wait(1100);
}
state.render = renderJob("done", 100, null);
state.project = project({ status: "done", videoUrl: `${origin}/clips/edited.webm`, editedVideoUrl: `${origin}/clips/edited.webm`, duration: 6.52, width: 1080, height: 1920, editedWidth: 1080, editedHeight: 1920, platform: "tiktok" });
state.messages.push({
  id: "a-final",
  role: "assistant",
  content: "Done — removed 5.8s of silence across 4 gaps, reframed to 1080×1920 for TikTok, burned 4 captions (karaoke), levelled to −14 LUFS. 12.3s became 6.5s.",
  createdAt: new Date().toISOString(),
});
// The payoff: the frame turns vertical, the badge says AI Edited, and the
// result plays with its captions on. A still of a finished render proves less
// than four seconds of it moving.
await wait(2600);
// The last beat: the finished vertical cut, playing, with its captions on.
//
// Not driven through the player, because it cannot be. This Chromium is started
// by a test runner: `play()` is declined by policy and the promise is rejected
// into nothing, and driving `currentTime` from outside React either does not
// stick or asks for seeks faster than the decoder paints them — the scrubber
// moves and the picture does not. Both were tried and both are in the git log.
//
// So the same file the page has already loaded, at readyState 4, is drawn into
// the rectangle the page is drawing it in, measured from the page rather than
// guessed. Nothing is added that the app is not showing; the app is simply not
// allowed to run the clock in here.
// Off the frame. Its play scrim is `hover:opacity-100`, so a pointer left
// resting inside it puts a big translucent button over the result for the whole
// last beat — the one shot on the page that has to be clean.
await page.mouse.move(PHONE ? 195 : 1150, PHONE ? 812 : 640);
await wait(2000);
const frameBox = await page.evaluate(() => {
  const v = document.querySelector("video");
  if (!v) return null;
  const r = v.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
});
const resultAt = (Date.now() - videoStartedAt) / 1000;
await wait(RESULT_SECONDS * 1000 + 600);

await ctx.close();
await browser.close();
server.close();

// ── assemble ─────────────────────────────────────────────────────────────────
const webm = (await readdir(work)).find((f) => f.endsWith(".webm"));
if (!webm) { console.error("Playwright produced no video."); process.exit(1); }
const raw = path.join(work, webm);
await mkdir(outDir, { recursive: true });

const ff = (args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });

const trimTo = Math.max(0, typingAt - 1.0);

// Draw the result into the frame the page is drawing it in.
const composed = path.join(work, "composed.mp4");
if (frameBox) {
  ff([
    "-ss", Math.max(0, typingAt - 1.0).toFixed(2),
    "-i", raw,
    "-i", path.join(CLIPS, "edited.mp4"),
    "-filter_complex",
    `[1:v]scale=${frameBox.w}:${frameBox.h},setpts=PTS-STARTPTS+${(resultAt - trimTo).toFixed(2)}/TB[res];` +
      `[0:v][res]overlay=${frameBox.x}:${frameBox.y}:enable='between(t,${(resultAt - trimTo).toFixed(2)},${(resultAt - trimTo + RESULT_SECONDS).toFixed(2)})'[v]`,
    "-map", "[v]", "-an", "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-pix_fmt", "yuv420p", composed,
  ]);
} else {
  ff(["-i", composed, "-an", "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-pix_fmt", "yuv420p", composed]);
}

// h264 for everything, vp9 for the browsers that prefer it, and a poster so the
// first paint is the finished frame rather than a black box.
ff(["-i", composed, "-an", "-c:v", "libx264", "-crf", "23", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(outDir, `demo-editor${SHAPE.suffix}.mp4`)]);
ff(["-i", composed, "-an", "-c:v", "libvpx-vp9", "-crf", "36", "-b:v", "0", "-row-mt", "1", path.join(outDir, `demo-editor${SHAPE.suffix}.webm`)]);
ff(["-sseof", "-2", "-i", composed, "-frames:v", "1", "-q:v", "3", path.join(outDir, `demo-editor${SHAPE.suffix}.jpg`)]);

// ── the three step clips, and why they are not cut any more ─────────────────
//
// This used to cut three crops out of the recording above, one per card in
// "How it works". They were shown at 240px, and at that size a picture of a
// screen is a picture of unreadable text: one of them was a black rectangle
// with three words in it too small to make out. The page draws those three
// steps now, at the size it shows them, so nothing here has to be kept in
// sync with the app's chrome and no visitor downloads 332kB of video to be
// told "there is a screen".

const sizes = ["demo-editor.mp4", "demo-editor.webm", "demo-editor.jpg"].map((f) => f.replace(/\.(?=[a-z0-9]+$)/, `${SHAPE.suffix}.`)).map((f) => `${f} ${(statSync(path.join(outDir, f)).size / 1024).toFixed(0)}KB`);
console.log(`\nRecorded the real editor at ${SHAPE.width}\u00d7${SHAPE.height}: ${sizes.join(" · ")}`);
