/**
 * The app at phone width.
 *
 * Every other suite in this repo reads the pages either as source text or at a
 * desktop viewport, and both are blind to the thing most people actually hold:
 * a 390px screen. "The mobile experience is bad" is not a bug report anyone can
 * act on, so this turns it into numbers — horizontal overflow, tap targets
 * under the 44px floor Apple and Google both publish, and text under 12px —
 * and it does it on the *built* bundle, because a class that Tailwind's purge
 * dropped is a class that does not exist.
 *
 * The signed-in pages are the point. They were never rendered at this width by
 * anything, because they need a session, so the harness plants one: a token in
 * localStorage under the key supabase-js reads, and every network call the page
 * makes answered from a fixture. Nothing real is contacted — the fixtures are
 * the contract the generated client already declares.
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

const FIXTURES = {
  "/api/stats/dashboard": {
    totalProjects: 3, processingCount: 1, stalledCount: 0, doneCount: 1,
    recentProjects: PROJECTS,
    worker: { online: true, lastSeenAt: "2026-08-24T09:31:00.000Z", transcription: "whisper-1", vision: null },
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
  },
  "/api/healthz": { status: "ok" },
  "/api/templates": [
    { id: "talking-head", name: "Talking head", description: "Silence out, framed vertical, levels fixed.", bestFor: "One person to camera", needs: null },
    { id: "on-the-beat", name: "On the beat", description: "Punches in on the beat of the track you picked.", bestFor: "Montages with music", needs: "music" },
  ],
};

function fixtureFor(pathname) {
  if (FIXTURES[pathname]) return FIXTURES[pathname];
  const id = pathname.match(/^\/api\/projects\/([^/]+)$/)?.[1];
  if (id) return PROJECTS.find((p) => p.id === id) ?? PROJECTS[0];
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
      { id: "m2", role: "assistant", content: "Done — removed 41 seconds of silence, reframed to 9:16, and levelled the audio to −14 LUFS.", createdAt: "2026-08-24T09:02:00.000Z" },
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
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ["--no-sandbox"] });
await mkdir(SHOTS, { recursive: true });

const PHONE = { width: 390, height: 844 };

async function open(url, { signedIn = false } = {}) {
  const ctx = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

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
    const fx = fixtureFor(u.pathname);
    if (fx && typeof fx.status === "number" && Object.keys(fx).length === 1) {
      return route.fulfill({ status: fx.status, json: { message: "no" } });
    }
    return route.fulfill({ json: fx });
  });

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

    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      overflowing,
      taps,
      tiny,
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
  { url: `/project/${PROJECTS[0].id}`, name: "the project editor", signedIn: true },
  { url: `/export/${PROJECTS[0].id}`, name: "the export screen", signedIn: true },
  { url: "/account", name: "the account page", signedIn: true },
  { url: "/admin", name: "the admin console", signedIn: true },
  { url: "/nowhere-at-all", name: "a page that is not there", signedIn: false },
];

for (const spec of PAGES) {
  section(`${spec.name} at ${PHONE.width}×${PHONE.height}`);
  const { ctx, page, consoleErrors } = await open(spec.url, { signedIn: spec.signedIn });
  const m = await measure(page);
  await page.screenshot({ path: path.join(SHOTS, `${spec.name.replace(/[^a-z]+/gi, "-")}.png`) });

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
  check(
    "every tap target is a thumb's width",
    m.taps.length === 0,
    m.taps.join(" | "),
  );
  check(
    "no body text is smaller than 12px",
    m.tiny.length === 0,
    m.tiny.map((t) => `${t.px}px "${t.t}"`).join(" | "),
  );
  await ctx.close();
}

await browser.close();
server.close();

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
