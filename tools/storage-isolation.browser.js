/**
 * Checks that the "videos" bucket's row-level security actually holds, against
 * the real Supabase project.
 *
 * The API-level test (tools/isolation-test.mjs) runs in Node and cannot reach
 * Storage, so this one runs in the browser instead. Storage policies are
 * enforced by Postgres, not by application code — a single bad policy silently
 * makes every user's footage readable, and nothing else in the test suite would
 * notice. Worth re-running after any change to the bucket or its policies.
 *
 * How to run:
 *   1. Open the deployed app and sign in as neither account (any page will do).
 *   2. Fill in TWO existing accounts below. They must both be confirmed.
 *   3. Paste this whole file into the DevTools console.
 *
 * It uploads ~2 KB under each account, proves neither can see the other's
 * object, and deletes what it created.
 */
(async () => {
  const SUPABASE_URL = window.location.origin.includes("localhost")
    ? prompt("Supabase URL")
    : "https://jszalanebxdshrwwegmg.supabase.co";

  const ANON_KEY = prompt("Supabase anon key");

  const ACCOUNTS = {
    a: { email: prompt("Account A email"), password: prompt("Account A password") },
    b: { email: prompt("Account B email"), password: prompt("Account B password") },
  };

  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail: ok ? "" : detail });
    console.log(`${ok ? "%c✓" : "%c✗"} ${name}${ok ? "" : ` — ${detail}`}`, `color:${ok ? "green" : "red"}`);
  };

  for (const who of ["a", "b"]) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(ACCOUNTS[who]),
    });
    const j = await r.json();
    if (!j.access_token) throw new Error(`could not sign in account ${who}: ${JSON.stringify(j)}`);
    ACCOUNTS[who].token = j.access_token;
    ACCOUNTS[who].id = j.user.id;
  }

  const api = async (who, path, method = "GET", body) => {
    const r = await fetch(path, {
      method,
      headers: { Authorization: `Bearer ${ACCOUNTS[who].token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* error page */ }
    return { status: r.status, json, text };
  };

  const store = async (who, path, method = "GET", { headers = {}, body } = {}) => {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/${path}`, {
      method,
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${ACCOUNTS[who].token}`, ...headers },
      body,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* binary or error page */ }
    return { status: r.status, json, text };
  };

  const jsonBody = (value) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });

  const created = await api("a", "/api/projects", "POST", { title: "Storage isolation check" });
  check("A can create a project", created.status === 201, `${created.status} ${created.text.slice(0, 120)}`);
  const projectId = created.json?.id;
  const key = `${ACCOUNTS.a.id}/${projectId}/source.mp4`;

  const bytes = new Uint8Array(2048).map((_, i) => i % 251);
  const upload = await store("a", `object/videos/${key}`, "POST", {
    headers: { "Content-Type": "video/mp4", "x-upsert": "true" },
    body: new Blob([bytes], { type: "video/mp4" }),
  });
  check("A can upload into her own folder", upload.status === 200, `${upload.status} ${upload.text.slice(0, 150)}`);

  const record = await api("a", `/api/projects/${projectId}`, "PATCH", { videoPath: key, status: "ready" });
  check("A can record the key on her project", record.json?.videoPath === key, `${record.status} ${record.text.slice(0, 120)}`);

  const signed = await store("a", `object/sign/videos/${key}`, "POST", jsonBody({ expiresIn: 300 }));
  check("A can mint a signed URL", !!signed.json?.signedURL, `${signed.status} ${signed.text.slice(0, 120)}`);

  if (signed.json?.signedURL) {
    const played = await fetch(`${SUPABASE_URL}/storage/v1${signed.json.signedURL}`);
    const buf = new Uint8Array(await played.arrayBuffer());
    check("the signed URL returns exactly what was uploaded", played.status === 200 && buf.length === 2048 && buf[7] === 7, `${played.status} len=${buf.length}`);
  }

  const bDownload = await store("b", `object/videos/${key}`);
  check("B cannot download A's object", bDownload.status >= 400, `got ${bDownload.status}`);

  const bSign = await store("b", `object/sign/videos/${key}`, "POST", jsonBody({ expiresIn: 300 }));
  check("B cannot mint a signed URL for A's object", bSign.status >= 400, `got ${bSign.status}`);

  const bOverwrite = await store("b", `object/videos/${key}`, "POST", {
    headers: { "Content-Type": "video/mp4", "x-upsert": "true" },
    body: new Blob([new Uint8Array(16)], { type: "video/mp4" }),
  });
  check("B cannot overwrite A's object", bOverwrite.status >= 400, `got ${bOverwrite.status}`);

  const bDelete = await store("b", `object/videos/${key}`, "DELETE");
  check("B cannot delete A's object", bDelete.status >= 400, `got ${bDelete.status}`);

  const bList = await store("b", "object/list/videos", "POST", jsonBody({ prefix: `${ACCOUNTS.a.id}/${projectId}`, limit: 100 }));
  check("A's folder is invisible in B's listing", Array.isArray(bList.json) && bList.json.length === 0, bList.text.slice(0, 150));

  // Refused either because the key is not shaped for this caller (400) or
  // because the project is not theirs (404). Both are refusals that reveal
  // nothing about whether the project exists.
  const bRecord = await api("b", `/api/projects/${projectId}`, "PATCH", { videoPath: key });
  check("B cannot attach A's key to anything", bRecord.status === 400 || bRecord.status === 404, `got ${bRecord.status}`);

  const intact = await store("a", "object/list/videos", "POST", jsonBody({ prefix: `${ACCOUNTS.a.id}/${projectId}`, limit: 100 }));
  check(
    "A's object survived all of that",
    Array.isArray(intact.json) && intact.json.some((o) => o.name === "source.mp4" && o.metadata?.size === 2048),
    intact.text.slice(0, 200),
  );

  // Clean up, the same way the dashboard does.
  const keys = (intact.json || []).filter((o) => o.id !== null).map((o) => `${ACCOUNTS.a.id}/${projectId}/${o.name}`);
  const removed = await store("a", "object/videos", "DELETE", jsonBody({ prefixes: keys }));
  check("the owner can reclaim her own objects", removed.status === 200, `${removed.status} ${removed.text.slice(0, 120)}`);

  const emptied = await store("a", "object/list/videos", "POST", jsonBody({ prefix: `${ACCOUNTS.a.id}/${projectId}`, limit: 100 }));
  check("the folder is empty afterwards", Array.isArray(emptied.json) && emptied.json.filter((o) => o.id !== null).length === 0, emptied.text.slice(0, 150));

  const deleted = await api("a", `/api/projects/${projectId}`, "DELETE");
  check("the project row is deleted", deleted.status === 204, `got ${deleted.status}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.error("FAILED:", failed);
  else console.log("Storage isolation holds.");
})();
