/**
 * The app at the widths people actually use it.
 *
 * Every other suite in this repo reads the pages as source text, and source
 * text cannot see a layout. This one renders the *built* bundle — because a
 * class Tailwind's purge dropped is a class that does not exist — and measures
 * what came out.
 *
 * It was phone-only, and called mobile-test, and that turned out to be half a
 * blind spot rather than none. Two layout bugs in a row were found by hand at
 * widths nothing here rendered: a send button that had never once been inside
 * the chat bar, and a player column sized to a 9:16 frame so that the scrubber
 * measured a single pixel. Both were invisible to every check, because a 1px
 * input is not an error, it is a layout. So it runs at a phone and at a laptop
 * now.
 *
 * The rules are not the same at both. 44px tap targets and a 12px text floor
 * are about fingers and phone screens, and this product deliberately uses
 * smaller controls on a desktop (`md:h-9` everywhere), so those are checked at
 * phone width only. What holds at every width is that the page renders, that it
 * does not scroll sideways, that nothing escapes its container, and that no
 * control has collapsed to nothing.
 *
 * The signed-in pages are the point. They were never rendered at any width by
 * anything, because they need a session, so the harness plants one: a token in
 * localStorage under the key supabase-js reads, and every network call answered
 * from a fixture. Nothing real is contacted.
 */
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { existsSync, statSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(repoRoot, "dist");
const SHOTS = process.env.MOBILE_SHOTS ?? "/tmp/mobile-shots";
const PROJECT_REF = "jszalanebxdshrwwegmg";
const USER_ID = "00000000-0000-4000-8000-00000000beef";

if (!existsSync(root)) {
  console.error("dist/ is not built — run `pnpm run vercel:build` from the repo root first.");
  process.exit(1);
}

let pass = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── the static site, served the way Vercel serves it ─────────────────────────
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff" };
const server = http.createServer(async (req, res) => {
  let p = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  if (!existsSync(p) || statSync(p).isDirectory()) p = path.join(root, "index.html");
  try {
    const body = await readFile(p);
    res.writeHead(200, { "Content-Type": types[path.extname(p)] ?? "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end("no"); }
});
const PORT = 4399;
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const origin = `http://127.0.0.1:${PORT}`;

// ── fixtures ─────────────────────────────────────────────────────────────────
const project = (id, title, status, extra = {}) => ({
  id, title, status,
  thumbnailUrl: null, videoUrl: null, editedVideoUrl: null,
  videoPath: `${USER_ID}/${id}/source.mp4`, editedVideoPath: null, thumbnailPath: null,
  referenceVideoPath: null, duration: 62.5, width: 1920, height: 1080,
  editedWidth: null, editedHeight: null, platform: "tiktok", renderStalled: false,
  createdAt: "2026-08-20T10:00:00.000Z", updatedAt: "2026-08-24T09:30:00.000Z",
  ...extra,
});

// Long titles on purpose: a card that only ever holds "My video" has never been
// asked the question this file exists to ask.
const PROJECTS = [
  project("11111111-1111-4111-8111-111111111111", "Podcast episode 14 — the whole two-hour take, unedited", "done"),
  project("22222222-2222-4222-8222-222222222222", "Store walkthrough", "processing"),
  project("33333333-3333-4333-8333-333333333333", "Launch teaser", "ready"),
];

/**
 * A clip shot the way a phone shoots.
 *
 * Every fixture above is 1920x1080, and a landscape clip on a phone is bound by
 * the width of the column — it can never be squeezed by the height the layout
 * has spent on other things. So the editor rules ran, and passed, against the
 * one shape that could not fail, while a 9:16 recording was rendering 129px
 * wide on a 390px screen. The suite was not wrong; it was answering about a
 * video nobody who uses this on a phone is editing.
 *
 * Kept out of PROJECTS so the dashboard fixtures still say three.
 */
const VERTICAL_PROJECT = project(
  "44444444-4444-4444-8444-444444444444",
  "Shot on a phone",
  "done",
  { width: 1080, height: 1920, editedWidth: 1080, editedHeight: 1920, duration: 21.4 },
);

const FIXTURES = {
  "/api/stats/dashboard": {
    totalProjects: 3, processingCount: 1, stalledCount: 0, doneCount: 1,
    recentProjects: PROJECTS,
    // Relative to now, not a date written down once.
    //
    // This was a fixed timestamp, so every day it aged further from the
    // `online: true` beside it. The screenshot this suite writes read
    // "online · last beat 6d 3h ago" — a state the server cannot produce, since
    // it calls a worker gone after two minutes. A fixture that drifts into an
    // impossible state is worse than no fixture: it renders a screen nobody can
    // trust, and it makes the one contradiction worth catching look normal.
    worker: { online: true, lastSeenAt: new Date(Date.now() - 20_000).toISOString(), transcription: "whisper-1", vision: null },
  },
  "/api/projects": PROJECTS,
  "/api/subscription": {
    plan: "creator", minutesIncluded: 60, minutesGranted: 0, minutesUsedThisMonth: 12.5,
    minutesRemaining: 47.5, maxUploadMinutes: 30, watermark: false, referenceStyle: true, pricePerMonth: 12,
  },
  // The admin console. It is the one screen in this product nobody has ever
  // looked at on a phone, and it is also the one somebody looks at *from* a
  // phone — at the moment a render is failing and they are not at a desk.
  "/api/admin/overview": {
    queue: { processing: 1, waiting: 2, unattended: 0, failedLastDay: 1, doneLastDay: 34 },
    worker: { online: true, lastSeenAt: "2026-08-24T09:31:00.000Z", transcription: "whisper-1", vision: null },
    accounts: { total: 218, newLastWeek: 19 },
    revenue: {
      byPlan: [
        { plan: "free", count: 180 }, { plan: "creator", count: 24 },
        { plan: "pro", count: 12 }, { plan: "studio", count: 2 },
      ],
      monthlyRecurringUsd: 794,
    },
    billing: [
      { eventId: "evt_1", type: "subscription.created", email: "someone@example.com", plan: "creator", receivedAt: "2026-08-24T08:00:00.000Z", applied: true, outcome: null },
      { eventId: "evt_2", type: "subscription.cancelled", email: "another.person.with.a.long.address@example.com", plan: "pro", receivedAt: "2026-08-23T21:12:00.000Z", applied: false, outcome: "no account for that email" },
    ],
    minutesRenderedThisMonth: 412.6,
    // The quiet fault: posts past their time that nothing has claimed. The
    // console must say this in the verdict at the top, not only as a number on
    // a card — it is the one failure on this screen that nobody complains
    // about, because the person it affects is not watching.
    posting: {
      dueSoon: 4,
      overdue: 2,
      stranded: 0,
      publishedLastDay: 11,
      failedLastDay: 1,
      missedLastDay: 1,
      accountsNeedingReconnect: 1,
    },
  },
  "/api/healthz": { status: "ok" },
  /*
    Two accounts on one platform, on purpose.

    Agencies run a client's Instagram and their own, and a composer that
    assumes one account per platform is a composer they cannot use. It is also
    the case that breaks a naive layout: two long handles on one row.
  */
  "/api/social/platforms": { platforms: [
    { platform: "instagram", label: "Instagram", connected: true, captionLimit: 2200, maxDurationSeconds: 5400, shape: "any", needsReview: true },
    { platform: "x", label: "X", connected: true, captionLimit: 280, maxDurationSeconds: 140, shape: "any", needsReview: false },
    { platform: "tiktok", label: "TikTok", connected: false, captionLimit: 2200, maxDurationSeconds: 600, shape: "vertical", needsReview: true },
    { platform: "facebook", label: "Facebook", connected: false, captionLimit: 63206, maxDurationSeconds: 14400, shape: "any", needsReview: true },
    { platform: "snapchat", label: "Snapchat", connected: false, captionLimit: 250, maxDurationSeconds: 180, shape: "vertical", needsReview: true },
  ] },
  "/api/social/accounts": {
    accounts: [
      { id: "acc_1", platform: "instagram", handle: "@studio.northlight", displayName: "Northlight", avatarUrl: null, status: "ok", statusDetail: null },
      { id: "acc_2", platform: "instagram", handle: "@a.client.with.a.long.handle", displayName: null, avatarUrl: null, status: "ok", statusDetail: null },
      { id: "acc_3", platform: "x", handle: "@northlight", displayName: null, avatarUrl: null, status: "ok", statusDetail: null },
    ],
  },
  "/api/social/posts": {
    posts: [
      { id: "sp_1", projectId: "p1", exportId: "exp_1", accountId: "acc_1", platform: "instagram",
        caption: "The one thing nobody tells you about recording at home", hashtags: ["#editing"],
        scheduledFor: new Date(Date.now() + 6 * 3600_000).toISOString(), status: "scheduled",
        externalUrl: null, error: null, publishedAt: null },
      { id: "sp_2", projectId: "p1", exportId: "exp_1", accountId: "acc_3", platform: "x",
        caption: "Short version", hashtags: [],
        scheduledFor: new Date(Date.now() - 26 * 3600_000).toISOString(), status: "published",
        externalUrl: "https://x.com/northlight/status/1", error: null,
        publishedAt: new Date(Date.now() - 26 * 3600_000).toISOString() },
      // The ending that is not a failure, and the long sentence that goes with
      // it. If the row cannot hold this, it cannot hold the case it exists for.
      { id: "sp_3", projectId: "p1", exportId: "exp_1", accountId: "acc_2", platform: "instagram",
        caption: "Behind the scenes", hashtags: [],
        scheduledFor: new Date(Date.now() - 50 * 3600_000).toISOString(), status: "missed",
        externalUrl: null,
        error: "This was due at 2026-08-28T19:00:00.000Z and is 121 minutes late, so it was not sent. Posting it now would put it in front of people at a time you did not choose. Schedule it again when you want it to go.",
        publishedAt: null },
    ],
  },
  "/api/templates": [
    { id: "talking-head", name: "Talking head", description: "Silence out, framed vertical, levels fixed.", bestFor: "One person to camera", needs: null },
    { id: "on-the-beat", name: "On the beat", description: "Punches in on the beat of the track you picked.", bestFor: "Montages with music", needs: "music" },
  ],
};

/**
 * A render that has finished.
 *
 * Without it the export screen answers 404 for the status and shows the
 * platform picker, which is a real state and not the one that carries the
 * scheduling composer — so the composer had no width at which anything
 * rendered it. `outputSeconds` is 21.4 and the source is 96: X stops at 140,
 * and using the wrong one of those two numbers is exactly the bug the route
 * was fixed for.
 */
const FINISHED_EXPORT = {
  id: "exp_1",
  projectId: PROJECTS[0].id,
  status: "done",
  platform: "tiktok",
  downloadUrl: null,
  outputPath: "renders/exp_1.mp4",
  outputSeconds: 21.4,
  steps: [
    { label: "Reading the take", status: "done" },
    { label: "Cutting", status: "done" },
    { label: "Rendering", status: "done" },
  ],
  notes: ["Framed on the subject.", "Captions burned in."],
  createdAt: "2026-08-24T09:00:00.000Z",
  updatedAt: "2026-08-24T09:04:00.000Z",
};

function fixtureFor(pathname) {
  if (FIXTURES[pathname]) return FIXTURES[pathname];
  if (/^\/api\/projects\/[^/]+\/export\/status$/.test(pathname)) return FINISHED_EXPORT;
  const id = pathname.match(/^\/api\/projects\/([^/]+)$/)?.[1];
  if (id) return [...PROJECTS, VERTICAL_PROJECT].find((p) => p.id === id) ?? PROJECTS[0];
  if (pathname === "/api/admin/accounts") {
    return {
      total: 218,
      accounts: [
        { userId: "u1", email: "someone@example.com", createdAt: "2026-08-01T10:00:00.000Z", lastSignInAt: "2026-08-24T07:00:00.000Z", plan: "creator", projectCount: 12, minutesUsedThisMonth: 22.5, minutesIncluded: 60 },
        { userId: "u2", email: "another.person.with.a.long.address@example.com", createdAt: "2026-07-14T10:00:00.000Z", lastSignInAt: null, plan: "free", projectCount: 1, minutesUsedThisMonth: 4, minutesIncluded: 5 },
      ],
    };
  }
  if (pathname === "/api/admin/jobs") {
    return {
      total: 2,
      jobs: [
        { id: "j1", userId: "u1", projectId: "p1", status: "running", progress: 62, stage: "Reframing to 9:16", error: null, attempts: 1, billedSeconds: null, createdAt: "2026-08-24T09:20:00.000Z", lockedAt: "2026-08-24T09:21:00.000Z", finishedAt: null, unattended: false, notes: null },
        { id: "j2", userId: "u2", projectId: "p2", status: "failed", progress: 0, stage: null, error: "This file is 4h 12m long and the plan allows 30m.", attempts: 1, billedSeconds: null, createdAt: "2026-08-24T08:02:00.000Z", lockedAt: null, finishedAt: "2026-08-24T08:03:00.000Z", unattended: false, notes: null },
      ],
    };
  }
  if (pathname === "/api/admin/actions") {
    return { total: 1, actions: [{ id: "a1", actorUserId: "admin", action: "grant_minutes", subjectUserId: "u2", subjectJobId: null, reason: "render failed on our side", detail: { minutes: 10 }, createdAt: "2026-08-24T08:30:00.000Z" }] };
  }
  if (pathname === "/api/admin/waitlist") {
    return { total: 3, entries: [{ email: "first@example.com", source: "landing", createdAt: "2026-08-20T10:00:00.000Z" }] };
  }
  if (/^\/api\/projects\/[^/]+\/messages$/.test(pathname)) {
    return [
      { id: "m1", role: "user", content: "Cut the silences and make it vertical for TikTok.", createdAt: "2026-08-24T09:00:00.000Z" },
      { id: "m2", role: "assistant", content: "Done. Removed 41 seconds of silence, reframed to 9:16, and levelled the audio to −14 LUFS.", createdAt: "2026-08-24T09:02:00.000Z" },
    ];
  }
  if (/\/clips$/.test(pathname)) return [];
  if (/\/export\/status$/.test(pathname)) return { state: "idle" };
  if (/\/render\/status$/.test(pathname)) return null;
  return {};
}

// ── the browser ──────────────────────────────────────────────────────────────
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
// SwiftShader gives this headless browser a working WebGL2, which the voice
// orb needs. Without it every run would exercise the CSS fallback and the
// shader would never be drawn by anything before a customer's machine.
const browser = await chromium.launch({
  ...(exe ? { executablePath: exe } : {}),
  args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
await mkdir(SHOTS, { recursive: true });

const PHONE = { width: 390, height: 844 };
const LAPTOP = { width: 1440, height: 900 };

/**
 * Where the app gets looked at, and which rules apply there.
 *
 * `phoneRules` is the ergonomics set — a 44px target and a 12px text floor —
 * which is about a fingertip on a small screen. Applying it to a desktop would
 * fail this product's own deliberate `md:` sizes, and dropping it from the
 * phone would give back the checks that have caught the most.
 */
const VIEWPORTS = [
  { name: "a phone", size: PHONE, mobile: true, phoneRules: true, hooks: true },
  { name: "a laptop", size: LAPTOP, mobile: false, phoneRules: false, hooks: true },
];

async function open(url, { signedIn = false, override = null, initScript = null, viewport = VIEWPORTS[0] } = {}) {
  const ctx = await browser.newContext({
    viewport: viewport.size,
    deviceScaleFactor: 2,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
  });

  // Everything the page would talk to, answered here. Supabase first, because
  // an unanswered token refresh is a spinner that never resolves.
  await ctx.route("**/*.supabase.co/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith("/auth/v1/settings")) {
      return route.fulfill({ json: { external: { google: true, apple: true } } });
    }
    if (u.pathname.startsWith("/auth/v1/user")) {
      return route.fulfill({ json: { id: USER_ID, email: "test@editly.test", user_metadata: {} } });
    }
    return route.fulfill({ json: {} });
  });
  await ctx.route(`${origin}/api/**`, async (route) => {
    const u = new URL(route.request().url());
    // A page can bend one fixture for its own run, so a state the product must
    // handle can be rendered without every other page seeing it too.
    const fx = override?.[u.pathname] ?? fixtureFor(u.pathname);
    if (fx && typeof fx.status === "number" && Object.keys(fx).length === 1) {
      return route.fulfill({ status: fx.status, json: { message: "no" } });
    }
    return route.fulfill({ json: fx });
  });

  // Anything a page needs to exist in the browser before it loads.
  if (initScript) await ctx.addInitScript(initScript);

  if (signedIn) {
    await ctx.addInitScript(
      ([ref, uid]) => {
        const session = {
          access_token: "header.eyJzdWIiOiJ0ZXN0In0.sig",
          token_type: "bearer",
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: "refresh",
          user: {
            id: uid, aud: "authenticated", role: "authenticated", email: "test@editly.test",
            app_metadata: { provider: "email" }, user_metadata: { full_name: "Test Person" },
            created_at: "2026-01-01T00:00:00.000Z",
          },
        };
        try { window.localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(session)); } catch { /* private mode */ }
      },
      [PROJECT_REF, uid_or(USER_ID)],
    );
  }

  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(process.env.MOBILE_STACK ? e.stack : e.message)));
  await page.goto(origin + url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  return { ctx, page, consoleErrors };
}
function uid_or(v) { return v; }

/** The three numbers, measured in the page. */
async function measure(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const vw = window.innerWidth;
    const visible = (e) => {
      const s = getComputedStyle(e);
      return s.visibility !== "hidden" && s.display !== "none" && e.getBoundingClientRect().width > 0;
    };
    // Only elements that can actually push the page sideways. A decorative blur
    // inside `overflow-hidden` is wider than the screen by design and is not a
    // bug; the document's own scroll width is the thing a thumb feels.
    const overflowing = [...document.querySelectorAll("*")]
      .filter((e) => {
        if (!visible(e)) return false;
        const r = e.getBoundingClientRect();
        if (r.width <= vw + 1) return false;
        for (let p = e.parentElement; p; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o === "hidden" || o === "clip" || o === "auto" || o === "scroll") return false;
        }
        return true;
      })
      .slice(0, 8)
      .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 50)} ${Math.round(e.getBoundingClientRect().width)}px`);

    // WCAG 2.5.8 exempts a target that sits inside a sentence, and it is right
    // to: growing "cancel it first at *your billing page*" to 44px does not
    // make the sentence easier to use, it makes it a stack of boxes. The test
    // is whether the parent has words of its own around the control — a button
    // alone in its container is a button, not a phrase.
    const inSentence = (e) => {
      const p = e.parentElement;
      if (!p) return false;
      const around = (p.textContent || "").replace(e.textContent || "", "").trim();
      return around.length > 8 && /^(P|SPAN|LI|DIV|LABEL|TD)$/.test(p.tagName);
    };
    const taps = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), [role="button"], [role="tab"]')]
      .filter((e) => visible(e) && !inSentence(e))
      .map((e) => ({ e, r: e.getBoundingClientRect() }))
      .filter(({ r }) => r.height > 0 && (r.height < 40 || r.width < 24))
      .slice(0, 10)
      .map(({ e, r }) => `${e.tagName.toLowerCase()}"${(e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 22)}" ${Math.round(r.width)}x${Math.round(r.height)}`);

    // Decoration is exempt: a drawn camera overlay inside a product mockup is
    // a picture of text, not text, and `aria-hidden` is the app already saying
    // so for a reason that has nothing to do with this check.
    const decorative = (e) => e.closest("[aria-hidden='true']") !== null;
    const tiny = [...document.querySelectorAll("p, span, li, div, label, td")]
      .filter((e) => e.children.length === 0 && (e.textContent || "").trim().length > 12 && visible(e) && !decorative(e))
      .map((e) => ({ px: parseFloat(getComputedStyle(e).fontSize), t: (e.textContent || "").trim().slice(0, 30) }))
      .filter((n) => n.px && n.px < 12);

    /*
     * A control that has collapsed, at any width.
     *
     * Weaker than the 44px floor on purpose, so it can hold on a desktop too:
     * this asks only whether something interactive still has a body. The
     * scrubber that measured one pixel wide passed every check in this file for
     * as long as it existed, because nothing looked at desktop and a 1px input
     * is a layout rather than an error.
     */
    const collapsed = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role="button"]')]
      .filter((e) => visible(e))
      .map((e) => ({ e, r: e.getBoundingClientRect() }))
      // A slider's track is thin across on purpose — `md:h-1.5` is a hairline
      // and that is the design. Along its own axis it still has to have a
      // body, which is the axis that collapsed.
      .filter(({ e, r }) => {
        if (r.width === 0 && r.height === 0) return false;
        const isSlider = e.tagName === "INPUT" && e.getAttribute("type") === "range";
        return isSlider ? r.width < 16 || r.height < 2 : r.width < 16 || r.height < 16;
      })
      .slice(0, 10)
      .map(({ e, r }) => `${e.tagName.toLowerCase()}"${(e.getAttribute("data-testid") || e.getAttribute("aria-label") || "").slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`);

    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      overflowing,
      taps,
      tiny,
      collapsed,
      title: document.title,
      // When the page does scroll sideways, say what pushed it.
      //
      // The offending element is almost never the widest one on the page — that
      // is usually a table inside a scroller, doing exactly what it should. It
      // is whatever reaches past the right edge with no clipping ancestor
      // between it and the document, and finding that by hand costs an hour.
      widest: (() => {
        if (doc.scrollWidth <= doc.clientWidth + 1) return [];
        const clipped = (el) => {
          for (let a = el.parentElement; a; a = a.parentElement) {
            const o = getComputedStyle(a).overflowX;
            if (o === "auto" || o === "hidden" || o === "scroll") return true;
          }
          return false;
        };
        return [...document.querySelectorAll("*")]
          .map((e) => ({ e, r: e.getBoundingClientRect() }))
          .filter(({ e, r }) => visible(e) && r.right > vw + 1 && !clipped(e))
          // A `position: fixed` box stretches to the scrollable canvas rather
          // than to the screen, so once anything overflows, every fixed element
          // reports as overflowing too. They are followers, never the cause.
          .filter(({ e }) => getComputedStyle(e).position !== "fixed")
          .sort((a, b) => b.r.right - a.r.right)
          .slice(0, 5)
          .map(({ e, r }) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 44)} right=${Math.round(r.right)} w=${Math.round(r.width)}`);
      })(),
    };
  });
}

const PAGES = [
  { url: "/", name: "the landing page", signedIn: false, expect: /Stop editing/ },
  { url: "/login", name: "signing in", signedIn: false, expect: /Welcome back|Sign in/ },
  { url: "/dashboard", name: "the dashboard", signedIn: true, expect: /Projects|project/i },
  {
    url: `/project/${PROJECTS[0].id}`,
    name: "the project editor",
    signedIn: true,
    then: async (page, check, viewport) => {
      /*
       * The scrubber has to be wide enough to scrub.
       *
       * The transport was sized to the picture so the two would line up edge to
       * edge, which is a good idea for a wide frame and was ruinous for a tall
       * one: a 9:16 video on a 390px phone is 169px wide, so a play button, a
       * scrubber and a timecode shared 135px of the screen and the scrubber
       * itself measured a single pixel. Every check here passed the whole time,
       * because a 1px-wide input is not an error — it is a layout.
       */
      const track = await page.getByTestId("input-scrubber").boundingBox();
      const view = page.viewportSize();
      check(
        "the scrubber is a usable fraction of the screen, not a hairline",
        Boolean(track && view && track.width >= view.width * 0.35),
        JSON.stringify({ track: track && Math.round(track.width), screen: view?.width }),
      );

      /*
       * And the video is a reasonable size in the room it has.
       *
       * The frame shares its height with the panels below it, so on a laptop it
       * came out 540x304 inside a 992-wide column — a small video in a video
       * editor, with a quarter of the column empty on either side of it. A
       * fraction rather than a number of pixels, so it holds at any window
       * size, and a loose one, because how big is a design decision and this
       * only has to notice when the frame has been squeezed out of the way.
       */
      const frame = await page.evaluate(() => {
        const el = document.querySelector('[class*="force-dark"][class*="rounded-2xl"]');
        // The stage, found by what it *is* rather than by a Tailwind value that
        // is a design decision and changes: it is the flex row the frame sits
        // in, directly inside the scrolling column.
        const column = el?.parentElement?.parentElement?.parentElement ?? null;
        if (!el || !column) return null;
        const f = el.getBoundingClientRect();
        const c = column.getBoundingClientRect();
        return { w: Math.round(f.width), h: Math.round(f.height), colW: Math.round(c.width) };
      });
      check(
        "and the video takes a real share of the width it has",
        Boolean(frame && frame.w >= frame.colW * 0.55),
        JSON.stringify(frame),
      );

    },
  },
  {
    // The same editor, given the shape a phone actually records.
    url: `/project/${VERTICAL_PROJECT.id}`,
    name: "the project editor, holding a clip shot on a phone",
    signedIn: true,
    then: async (page, check, viewport) => {
      if (!viewport.phoneRules) return;
      /*
       * A real share of the *screen*, not of the column.
       *
       * The ratio measured above is the right question on a laptop and not
       * enough here, where the column is the screen and the frame was still
       * 129px of it. A 9:16 clip is height-bound: what decides its width is how
       * much height the layout has already spent on a conversation panel and a
       * control bar under the picture, and neither of those is visible to a
       * ratio taken inside the column.
       *
       * Two thirds, because that is roughly where a vertical clip stops looking
       * like a thumbnail of a video and starts looking like the video. It is a
       * floor, not a target.
       */
      const frame = await page.evaluate(() => {
        const el = document.querySelector('[class*="force-dark"][class*="rounded-2xl"]');
        if (!el) return null;
        const f = el.getBoundingClientRect();
        return { w: Math.round(f.width), h: Math.round(f.height) };
      });
      const view = page.viewportSize();
      check(
        "the picture is most of the screen, not a thumbnail of one",
        Boolean(frame && view && frame.w >= view.width * 0.66),
        JSON.stringify({ ...frame, screen: view?.width }),
      );
      // The height it needs has to come from somewhere, and where it comes from
      // is the controls moving onto the picture. Named separately because the
      // width above could also be reached by a layout that simply overflows.
      check(
        "because the play and scrub controls are on the picture rather than under it",
        (await page.getByTestId("transport-on-picture").count()) > 0,
      );
      // And the thing they are on top of is still scrubbable.
      const track = await page.getByTestId("input-scrubber").boundingBox();
      check(
        "and the scrubber under them is still a scrubber",
        Boolean(track && view && track.width >= view.width * 0.35),
        JSON.stringify({ track: track && Math.round(track.width), screen: view?.width }),
      );
    },
  },
  {
    url: `/export/${PROJECTS[0].id}`,
    name: "the export screen",
    signedIn: true,
    then: async (page, check, viewport) => {
      const composer = page.getByTestId("schedule-composer");
      check("the scheduling composer is on the screen", await composer.isVisible(), "");

      // A destination is a tap target before it is a chip. Phone only — this
      // product uses smaller controls on a desktop on purpose.
      if (viewport.phoneRules) {
        const box = await page.getByTestId("destination-acc_1").boundingBox();
        check(
          "picking where it goes is a real tap target",
          Boolean(box && box.height >= 44),
          JSON.stringify(box && Math.round(box.height)),
        );
      }

      /*
        The count is against the tightest limit among the places chosen, and it
        has to *move* when the destinations do.

        Instagram alone is 2,200 characters; adding X drops the ceiling to 280.
        A count that stayed on the first platform picked would read as fine
        while the caption was already too long for one of them — and the person
        would find out at 9pm.
      */
      await page.getByTestId("destination-acc_1").click();
      const wide = await page.getByTestId("caption-count").innerText();
      await page.getByTestId("destination-acc_3").click();
      const tight = await page.getByTestId("caption-count").innerText();
      check(
        "the character count follows the strictest destination chosen",
        wide.includes("2200") && tight.includes("280"),
        `${wide} then ${tight}`,
      );

      // And the refusal has to appear while typing, not after pressing.
      await page.getByTestId("input-caption").fill("a".repeat(300));
      await page.waitForTimeout(120);
      check(
        "a caption too long for one destination says so before anything is sent",
        await page.getByTestId("schedule-refusals").isVisible(),
        "",
      );
      const button = await page.getByTestId("button-schedule").innerText();
      check(
        "and the button says what is wrong rather than being silently dead",
        /to fix first/.test(button),
        button,
      );
      check(
        "the platform that needs shorter words gets its own box",
        await page.getByTestId("override-x").isVisible(),
        "",
      );
    },
  },
  // The library of everything cut out of every recording. On the list because
  // a screen that is only ever opened by somebody who already has clips is a
  // screen nobody looks at until a customer does.
  { url: "/clips", name: "the clips library", signedIn: true },
  {
    url: "/account",
    name: "the account page",
    signedIn: true,
    then: async (page, check) => {
      check(
        "what is scheduled is on the screen, not only in the API",
        await page.getByTestId("scheduled-posts").isVisible(),
        // Both endpoints existed and nothing called either. A feature that
        // only exists in an API is a feature nobody has.
        "",
      );
      check(
        "a post that has not left can be called back",
        await page.getByTestId("button-cancel-sp_1").isVisible(),
        "",
      );
      check(
        "one that already went cannot",
        !(await page.getByTestId("button-cancel-sp_2").isVisible()),
        "cancelling something that has been posted is a button that lies",
      );
      check(
        "and a post that was too late says so rather than saying it failed",
        (await page.getByTestId("scheduled-post-sp_3").innerText()).includes("too late"),
        await page.getByTestId("scheduled-post-sp_3").innerText(),
      );
    },
  },
  { url: "/admin", name: "the admin console", signedIn: true, then: async (page, check) => {
      const verdict = await page.getByTestId("admin-attention").innerText();
      check(
        "the verdict names posts that are overdue, not just renders",
        /scheduled post/i.test(verdict) && /2/.test(verdict),
        verdict,
      );
      check(
        "and an account whose token the platform stopped accepting",
        /no longer accepts/.test(verdict),
        // Every post scheduled to it fails one at a time as each comes due.
        // Seeing it once beforehand is the difference.
        verdict,
      );
      check("the posting row is on the screen", await page.getByTestId("admin-posting").isVisible(), "");

      // The word and the number on the worker card come from one row and must
      // agree. Checked on the rendered card rather than on the fixture, because
      // the defect this catches is the card presenting a contradiction calmly.
      const card = await page.evaluate(() => {
        const label = [...document.querySelectorAll("*")].find((e) => e.textContent?.trim() === "Worker");
        const box = label?.closest("div")?.parentElement;
        return box?.innerText ?? "";
      });
      check("the worker card says what it means", /online|offline|unclear/i.test(card), card);

      /*
       * And the console answers its first question before you read anything.
       *
       * This screen holds eight sections and used to ask you to read all eight
       * to find out whether any of them was bad news — which is the wrong order
       * for a screen somebody opens *because* something might be wrong. Either
       * banner is fine; a screen with neither is one that has gone back to
       * making you look.
       */
      const attention = await page.getByTestId("admin-attention").count();
      const clear = await page.getByTestId("admin-attention-clear").count();
      check(
        "and the page says up front whether anything needs somebody",
        attention + clear === 1,
        `attention=${attention} clear=${clear}`,
      );
      const stale = /last beat (\d+)\s*(m|h|d)/.exec(card);
      const saysOnline = /\bonline\b/i.test(card) && !/unclear/i.test(card);
      const minutes = stale ? Number(stale[1]) * ({ m: 1, h: 60, d: 1440 }[stale[2]] ?? 1) : 0;
      check(
        "and does not call a worker online whose last beat is older than the server's own threshold",
        !(saysOnline && minutes > 2),
        card,
      );
    } },
  {
    // The same screen, told something impossible.
    //
    // The server calls a worker gone after two minutes, so `online: true` beside
    // a six-day-old beat is a state it cannot produce — which is exactly why the
    // console never checked, and why it rendered that pair calmly for days. A
    // stale cache, a clock that disagrees, or a bug in the threshold all arrive
    // looking like this. The console exists to notice.
    url: "/admin",
    name: "the admin console told two things that cannot both be true",
    signedIn: true,
    override: {
      "/api/admin/overview": {
        ...FIXTURES["/api/admin/overview"],
        worker: { online: true, lastSeenAt: "2026-08-24T09:31:00.000Z", transcription: null, vision: null },
      },
    },
    then: async (page, check) => {
      const card = await page.evaluate(() => {
        const label = [...document.querySelectorAll("*")].find((e) => e.textContent?.trim() === "Worker");
        return label?.closest("div")?.parentElement?.innerText ?? "";
      });
      check(
        "it refuses to call that worker online",
        !/^\s*Worker\s*\n\s*online\b/im.test(card),
        card,
      );
      check(
        "and says which two facts disagree, rather than showing both without comment",
        /both cannot be true/i.test(card),
        card,
      );
    },
  },
  {
    /*
     * Speaking to the editor.
     *
     * `SpeechRecognition` does not exist in a headless browser, and the mic
     * button is deliberately not rendered where it cannot work — so without the
     * stub below, this whole feature would be invisible to every check in this
     * repository and would first be exercised on somebody's phone.
     *
     * The stub is the browser's shape, not the product's: a constructor with
     * the three handlers the hook attaches. It answers with one phrase, so the
     * assertion can be that the phrase reached the chat input rather than that
     * something happened.
     */
    url: `/project/${PROJECTS[0].id}`,
    name: "describing an edit out loud",
    signedIn: true,
    initScript: () => {
      class FakeRecognition {
        constructor() {
          this.lang = "";
          this.continuous = false;
          this.interimResults = false;
          this.maxAlternatives = 1;
          this.onresult = null;
          this.onerror = null;
          this.onend = null;
        }
        start() {
          setTimeout(() => {
            this.onresult?.({
              resultIndex: 0,
              results: Object.assign([Object.assign([{ transcript: "cut the dead air" }], { isFinal: true })], {
                length: 1,
              }),
            });
          }, 60);
        }
        stop() {
          this.onend?.();
        }
        abort() {
          this.onend?.();
        }
      }
      Object.defineProperty(window, "SpeechRecognition", { value: FakeRecognition, writable: true });
      // No microphone in here either, and the hook must survive that: the level
      // meter is a separate request from the words, and losing it costs the
      // animation, not the transcript.
      Object.defineProperty(navigator, "mediaDevices", {
        value: { getUserMedia: () => Promise.reject(new Error("no microphone in a test browser")) },
        writable: true,
      });
    },
    then: async (page, check) => {
      const mic = page.getByTestId("button-voice");
      check("the microphone is offered", (await mic.count()) === 1, String(await mic.count()));

      // The orb is the button, not a thing a sheet opens. Pressing it must not
      // take the editor over: the video, the timeline and the moment somebody
      // parked on are what they are talking *about*.
      const orbInButton = await page.evaluate(() =>
        Boolean(document.querySelector('[data-testid="button-voice"] [data-testid="voice-orb"]')),
      );
      check("and the orb is the button itself", orbInButton, "");

      await mic.first().click();
      await page.waitForTimeout(400);

      check(
        "pressing it opens no overlay over the editor",
        (await page.getByTestId("voice-sheet").count()) === 0,
        "an overlay was rendered",
      );
      check(
        "the video is still on screen while listening",
        await page.getByTestId("input-scrubber").isVisible(),
        "",
      );

      const orb = await page.evaluate(() => {
        const host = document.querySelector('[data-testid="voice-orb"]');
        const canvas = host?.querySelector("canvas");
        return {
          present: Boolean(host),
          canvasPainted: canvas ? canvas.width > 0 && canvas.height > 0 : false,
          fallback: (() => {
            const el = host?.querySelector('[data-testid="voice-orb-fallback"]');
            return { present: Boolean(el), hidden: el ? el.hidden : null };
          })(),
          gl: (() => {
            try {
              return Boolean(document.createElement("canvas").getContext("webgl2"));
            } catch {
              return false;
            }
          })(),
        };
      });
      // The chat bar on its own, which is where this control actually lives.
      const bar = await page.getByTestId("input-chat").locator("xpath=ancestor::form").first();
      await bar.screenshot({ path: path.join(SHOTS, "the-voice-bar.png") }).catch(() => {});
      await page.screenshot({ path: path.join(SHOTS, "the-voice-orb.png") });
      /*
       * The send button has to be *inside* the chat bar.
       *
       * `.hover-elevate:not(...)` is two classes of specificity and Tailwind's
       * `.absolute` is one, so this button — the only one in the app that
       * positions itself — computed `relative` and rendered in normal flow,
       * below and to the left of the input it belongs in, on every phone. The
       * class was in the markup and in the bundle the whole time, which is why
       * reading the JSX could never have found it. Geometry can.
       */
      const layout = await page.evaluate(() => {
        const send = document.querySelector('[data-testid="button-send-message"]');
        const input = document.querySelector('[data-testid="input-chat"]');
        if (!send || !input) return null;
        const s = send.getBoundingClientRect();
        const i = input.getBoundingClientRect();
        return {
          position: getComputedStyle(send).position,
          inside: s.left >= i.left - 2 && s.right <= i.right + 2 && s.top >= i.top - 2 && s.bottom <= i.bottom + 2,
          send: { x: Math.round(s.x), y: Math.round(s.y) },
          input: { x: Math.round(i.x), y: Math.round(i.y), w: Math.round(i.width), h: Math.round(i.height) },
        };
      });
      check(
        "a button that says it is absolute is absolute",
        layout?.position === "absolute",
        JSON.stringify(layout),
      );
      check(
        "and the send button sits inside the chat bar rather than under it",
        layout?.inside === true,
        JSON.stringify(layout),
      );
      const box = await page.getByTestId("button-voice").boundingBox();
      check(
        "the orb button has a real box in the chat bar",
        Boolean(box && box.width >= 32 && box.height >= 32),
        JSON.stringify(box),
      );
      check("the orb is on screen", orb.present, JSON.stringify(orb));
      check("with a canvas sized to something", orb.canvasPainted, JSON.stringify(orb));
      check("and a sphere underneath for browsers with no WebGL2", orb.fallback.present, JSON.stringify(orb));
      check(
        orb.gl ? "and it retires once the shader is painting" : "and it is what is showing, because this browser has no WebGL2",
        orb.gl ? orb.fallback.hidden === true : orb.fallback.hidden === false,
        JSON.stringify(orb),
      );

      /*
       * The one that matters, and it is stricter than it was.
       *
       * The words must arrive in the chat input *while* being said, not be
       * handed over when something closes. Waiting for a hand-off is what made
       * the first version feel like a separate machine you dictate to rather
       * than a box you can talk into.
       */
      const typed = await page.getByTestId("input-chat").inputValue();
      check(
        "what was said is in the chat input while it is still listening",
        /cut the dead air/i.test(typed),
        typed,
      );

      /*
       * There is no microphone in this browser, and the words still arrive.
       *
       * The stub above rejects `getUserMedia`, which is what the loudness meter
       * needs and the recogniser does not. Only a denied permission or a
       * missing device blocks recognition, because those block the recogniser
       * too; anything else costs the animation and not the feature. Written
       * down because the first version of the permission fix returned early on
       * *every* failure and turned this into a dead button.
       */
      check(
        "and losing the level meter costs the animation, not the words",
        (await page.getByTestId("button-voice").getAttribute("aria-pressed")) === "true",
        "the button stopped listening when the meter failed",
      );

    },
  },
  {
    /*
     * The other way to ask for an edit: stop on a second and say what happens
     * there.
     *
     * The assertion that matters is the last one. A mark is not a new kind of
     * instruction — it is folded into the same sentence typing produces, in the
     * form both heads of the planner already parse. If it ever became its own
     * request, every refusal, every language rule and every limit would have to
     * exist twice.
     */
    url: `/project/${PROJECTS[0].id}`,
    name: "directing one moment rather than the whole video",
    signedIn: true,
    then: async (page, check) => {
      const add = page.getByTestId("button-add-mark");
      check("a moment can be noted from the player", (await add.count()) === 1, String(await add.count()));

      // Park the playhead somewhere that is not zero, so "it used the time"
      // and "it used a default" cannot look the same.
      await page.getByTestId("input-scrubber").evaluate((el) => {
        const input = el;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, "26");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.waitForTimeout(150);

      await add.click();
      const at = await page.getByTestId("text-mark-time").innerText();
      check("the note is pinned to where the playhead is", at.trim() === "0:26", at);

      await page.getByTestId("input-mark").fill("punch in");
      await page.getByTestId("button-save-mark").click();
      await page.waitForTimeout(150);

      const listed = await page.getByTestId("list-marks").innerText();
      check("and it is listed with its timecode", /0:26/.test(listed) && /punch in/.test(listed), listed);

      /*
       * And it is *on the timeline*, at the right place.
       *
       * A note pinned to 0:26 that shows only as a row of text underneath is a
       * list of timecodes, not a timeline — you cannot see where in the video
       * your notes are, which is the whole point of stopping on a second. The
       * position is checked as a fraction of the track rather than in pixels,
       * so it holds at any width.
       */
      const pin = await page.evaluate(() => {
        const p = document.querySelector('[data-testid="mark-pin"]');
        const track = document.querySelector('[data-testid="input-scrubber"]');
        if (!p || !track) return null;
        const pb = p.getBoundingClientRect();
        const tb = track.getBoundingClientRect();
        return {
          fraction: (pb.left + pb.width / 2 - tb.left) / tb.width,
          onTrack: pb.top < tb.bottom && pb.bottom > tb.top,
        };
      });
      check("the note shows as a pin on the scrubber", pin !== null, JSON.stringify(pin));
      // 26s of the fixture's 62s duration.
      check(
        "at the fraction of the timeline it happens at",
        pin !== null && Math.abs(pin.fraction - 26 / 62) < 0.04,
        JSON.stringify(pin),
      );
      check("and sitting on the track rather than beside it", pin?.onTrack === true, JSON.stringify(pin));

      // With a mark and nothing typed, the send button has to be live: pointing
      // at a moment is the whole instruction.
      const send = page.getByTestId("button-send-message");
      check("sending is possible with a mark and no sentence", !(await send.isDisabled()), "");

      // Removing it puts everything back, including the button.
      await page.getByTestId("button-remove-mark").click();
      await page.waitForTimeout(150);
      check("removing the note empties the list", (await page.getByTestId("list-marks").count()) === 0, "");
      check("and the send button goes back to needing words", await send.isDisabled(), "");
    },
  },
  { url: "/nowhere-at-all", name: "a page that is not there", signedIn: false },
];

for (const viewport of VIEWPORTS) {
  for (const spec of PAGES) {
    section(`${spec.name} on ${viewport.name}, ${viewport.size.width}×${viewport.size.height}`);
    const { ctx, page, consoleErrors } = await open(spec.url, {
      signedIn: spec.signedIn,
      override: spec.override,
      initScript: spec.initScript,
      viewport,
    });
    const m = await measure(page);
    const shot = `${spec.name.replace(/[^a-z]+/gi, "-")}${viewport.phoneRules ? "" : "-wide"}.png`;
    // Full page, not the viewport. Half of what this suite exists to look at
    // is below the fold on a phone — the screenshot is how a person reviews
    // what the numbers cannot describe, and a screenshot that stops at 844px
    // shows the header of every screen and the content of none.
    await page.screenshot({ path: path.join(SHOTS, shot), fullPage: true });

    check("it renders without throwing", consoleErrors.length === 0, consoleErrors[0] ?? "");
    check(
      "the page does not scroll sideways",
      m.scrollWidth <= m.clientWidth + 1,
      `${m.scrollWidth} > ${m.clientWidth}: ${(m.widest ?? []).join(" | ") || m.overflowing.join(" | ")}`,
    );
    check(
      "nothing wider than the screen escapes its container",
      m.overflowing.length === 0,
      m.overflowing.join(" | "),
    );

    /*
     * A control that has collapsed to nothing, at any width.
     *
     * This is the rule that would have caught the scrubber: it measured one
     * pixel wide because the column it lived in was sized to a 9:16 frame, and
     * a 1px input is not an error to anything that reads source. The 44px floor
     * below catches it too, but only on a phone — this one holds everywhere,
     * and asks a much weaker question so it can.
     */
    check(
      "no control has collapsed to nothing",
      m.collapsed.length === 0,
      m.collapsed.join(" | "),
    );

    if (viewport.phoneRules) {
      check("every tap target is a thumb's width", m.taps.length === 0, m.taps.join(" | "));
      check(
        "no body text is smaller than 12px",
        m.tiny.length === 0,
        m.tiny.map((t) => `${t.px}px "${t.t}"`).join(" | "),
      );
    }

    // Anything this page in particular has to say for itself. Written against
    // the phone flow, so they run there.
    if (spec.then && viewport.hooks) await spec.then(page, check, viewport);
    await ctx.close();
  }
}

await browser.close();
server.close();

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
