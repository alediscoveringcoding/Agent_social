#!/usr/bin/env node
// Minimal in-memory stand-in for the site's worker API (PRD section 10.3).
// This is PRD workstream task B9 ("Mock site API for B's tests... worker CI
// runs without the real site"), built now so the worker has something to
// talk to before Track A's Next.js admin exists.
//
// Not a spec implementation: no persistence, no RLS, no cap/stale-window
// enforcement. Good enough to drive every delivery/generation state the
// worker needs to exercise locally.

import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { config as loadEnv } from "dotenv";
import canonicalize from "canonicalize";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Worker and mock-site share one token so the demo only needs one .env.
loadEnv({ path: path.resolve(__dirname, "../.env") });

const PORT = Number(process.env.MOCK_SITE_PORT || 3000);
const WORKER_TOKEN = process.env.WORKER_TOKEN;
if (!WORKER_TOKEN) {
  console.error("WORKER_TOKEN is not set (expected in worker/.env). Refusing to start.");
  process.exit(1);
}

// Mirrors worker/src/delivery/hash.ts and site/src/lib/social/hash.ts: both
// real sides normalize scheduled_at before hashing, so this fixture must too
// or its destination_hash would never match the worker's recomputation.
function toHashTimestamp(value) {
  const truncated = new Date(Math.floor(new Date(value).getTime() / 1000) * 1000);
  return truncated.toISOString().replace(".000Z", "Z");
}

function destinationHash(input) {
  const canonical = canonicalize({ ...input, scheduled_at: toHashTimestamp(input.scheduled_at) });
  return createHash("sha256").update(canonical).digest("hex");
}

// --- in-memory state ---------------------------------------------------

const state = {
  accounts: new Map(),
  deliveryJobs: new Map(),
  generationRequests: new Map(),
  workers: new Map(),
};

function seedAccount({ platform, display_name, postiz_integration_id }) {
  const id = randomUUID();
  state.accounts.set(id, {
    id,
    platform,
    display_name,
    postiz_integration_id,
    status: "connected",
  });
  return id;
}

function seedDeliveryJob({ accountId, text, scheduledAt }) {
  const destination_id = randomUUID();
  const destination = {
    id: destination_id,
    text,
    settings: {},
    // The real site always sends this pre-normalized ("Already in hash form").
    scheduled_at: toHashTimestamp(scheduledAt),
    destination_hash: "",
  };
  const account = state.accounts.get(accountId);
  destination.destination_hash = destinationHash({
    account_id: accountId,
    platform: account.platform,
    text: destination.text,
    settings: destination.settings,
    scheduled_at: destination.scheduled_at,
    media: [],
  });

  const job_id = randomUUID();
  state.deliveryJobs.set(job_id, {
    job_id,
    kind: "publish",
    status: "queued",
    attempt_no: 0,
    run_at: scheduledAt,
    account,
    destination,
    media: [],
    lease_expires_at: null,
  });
  return job_id;
}

function seedGenerationRequest({ brand, input }) {
  // worker-api.openapi.yaml: GenerationRequest.brand is a plain slug string,
  // e.g. "the-crypto-support" - not an {slug, name} object.
  const request_id = randomUUID();
  state.generationRequests.set(request_id, {
    request_id,
    status: "queued",
    brand,
    input,
    drafts: [],
    lease_expires_at: null,
  });
  return request_id;
}

function seed() {
  const devtoAccount = seedAccount({
    platform: "devto",
    display_name: "dev.to (throwaway)",
    postiz_integration_id: "mock-devto-1",
  });

  seedDeliveryJob({
    accountId: devtoAccount,
    text: "Declaratia Unica se depune pana pe 25 mai. The Crypto Support te ajuta sa calculezi impozitul pe tranzactiile crypto.",
    scheduledAt: new Date().toISOString(),
  });

  seedGenerationRequest({
    brand: "the-crypto-support",
    input: {
      source: { type: "topic", topic: "Declaratia Unica", hooks: ["deadline 25 mai"] },
      platforms: ["devto"],
      kinds: ["social"],
      count: 2,
      language: "ro",
      templates: ["dark"],
    },
  });

  console.log(
    JSON.stringify({
      msg: "mock-site seeded",
      accounts: state.accounts.size,
      deliveryJobs: state.deliveryJobs.size,
      generationRequests: state.generationRequests.size,
    }),
  );
}

seed();

// --- HTTP plumbing -------------------------------------------------------

function send(res, status, body) {
  const json = JSON.stringify(body ?? {});
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function touchWorker(req) {
  const workerId = req.headers["x-worker-id"] || "unknown";
  state.workers.set(workerId, {
    worker_id: workerId,
    version: req.headers["x-worker-version"] || null,
    last_seen_at: new Date().toISOString(),
  });
}

// --- demo dashboard (static HTML, polls /debug/state) -------------------

const DASHBOARD_HTML = `<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>social-infra — demo dashboard</title>
<style>
  :root { --ink:#16313a; --ink-soft:#5d7178; --accent:#11a594; --accent-dark:#0c7f72;
          --accent-soft:#d6f0ea; --bg:#fff; --bg-soft:#f4faf8; --line:#e6ede9; --gold:#e8a805; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,"Segoe UI",Roboto,sans-serif; background:var(--bg-soft); color:var(--ink); }
  header { background:var(--ink); color:#fff; padding:16px 24px; display:flex; justify-content:space-between; align-items:center; }
  header h1 { margin:0; font-size:18px; }
  header span { color:#9fd; font-size:13px; }
  main { max-width: 980px; margin: 0 auto; padding: 24px; }
  section { background:var(--bg); border:1px solid var(--line); border-radius:12px; padding:20px; margin-bottom:20px; }
  h2 { margin:0 0 14px; font-size:15px; text-transform:uppercase; letter-spacing:.04em; color:var(--ink-soft); }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--ink-soft); font-weight:600; font-size:12px; text-transform:uppercase; }
  .badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:700; }
  .badge.published { background:var(--accent-soft); color:var(--accent-dark); }
  .badge.queued { background:#fff3d6; color:#92650a; }
  .badge.claimed, .badge.submitting, .badge.running { background:#e6f0ff; color:#1d4ed8; }
  .badge.failed { background:#fde2e1; color:#b42318; }
  .muted { color:var(--ink-soft); font-size:12px; }
  form { display:flex; gap:8px; margin-top:14px; flex-wrap:wrap; }
  input, select { padding:8px 10px; border:1px solid var(--line); border-radius:8px; font-size:14px; flex:1; min-width:160px; }
  button { padding:8px 16px; border:none; border-radius:8px; background:var(--accent); color:#fff; font-weight:700; cursor:pointer; }
  button:hover { background:var(--accent-dark); }
  a.url { color:var(--accent-dark); }
  .empty { color:var(--ink-soft); font-style:italic; }
</style>
</head>
<body>
<header>
  <h1>social-infra &middot; demo dashboard</h1>
  <span id="status">loading...</span>
</header>
<main>
  <section>
    <h2>Accounts</h2>
    <table><thead><tr><th>Platform</th><th>Name</th><th>Status</th></tr></thead>
      <tbody id="accounts"></tbody></table>
  </section>

  <section>
    <h2>Delivery jobs</h2>
    <table><thead><tr><th>Text</th><th>Status</th><th>Attempt</th><th>Result</th></tr></thead>
      <tbody id="jobs"></tbody></table>
    <form id="newJobForm">
      <select id="accountSelect"></select>
      <input id="jobText" placeholder="Textul postarii de test..." value="Test din dashboard: Declaratia Unica pana pe 25 mai.">
      <button type="submit">Pune la coada</button>
    </form>
  </section>

  <section>
    <h2>Generation requests</h2>
    <table><thead><tr><th>Brand</th><th>Topic</th><th>Status</th><th>Drafts</th></tr></thead>
      <tbody id="requests"></tbody></table>
  </section>

  <section>
    <h2>Workers</h2>
    <table><thead><tr><th>Worker ID</th><th>Last seen</th></tr></thead>
      <tbody id="workers"></tbody></table>
  </section>
</main>
<script>
function badge(s) { return '<span class="badge ' + s + '">' + s + '</span>'; }
function timeAgo(iso) {
  if (!iso) return '-';
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return sec < 5 ? 'now' : sec + 's ago';
}

async function refresh() {
  let data;
  try {
    const res = await fetch('/debug/state');
    data = await res.json();
    document.getElementById('status').textContent = 'live';
  } catch {
    document.getElementById('status').textContent = 'disconnected';
    return;
  }

  const accSel = document.getElementById('accountSelect');
  const prevSel = accSel.value;
  accSel.innerHTML = data.accounts.map(a => '<option value="' + a.id + '">' + a.platform + ' - ' + a.display_name + '</option>').join('');
  if (prevSel) accSel.value = prevSel;

  document.getElementById('accounts').innerHTML = data.accounts.map(a =>
    '<tr><td>' + a.platform + '</td><td>' + a.display_name + '</td><td>' + badge(a.status) + '</td></tr>'
  ).join('') || '<tr><td colspan="3" class="empty">niciun cont</td></tr>';

  document.getElementById('jobs').innerHTML = data.deliveryJobs.map(j =>
    '<tr><td>' + (j.destination.text.length > 70 ? j.destination.text.slice(0,70) + '...' : j.destination.text) +
    '</td><td>' + badge(j.status) + '</td><td>' + j.attempt_no + '</td><td>' +
    (j.remote_url ? '<a class="url" href="' + j.remote_url + '" target="_blank">url</a>' : (j.last_error_code || '-')) +
    '</td></tr>'
  ).join('') || '<tr><td colspan="4" class="empty">niciun job</td></tr>';

  document.getElementById('requests').innerHTML = data.generationRequests.map(r =>
    '<tr><td>' + r.brand + '</td><td>' + (r.input.source.topic || r.input.source.url || '-') +
    '</td><td>' + badge(r.status) + '</td><td>' + r.drafts.length + '</td></tr>'
  ).join('') || '<tr><td colspan="4" class="empty">nicio cerere</td></tr>';

  document.getElementById('workers').innerHTML = data.workers.map(w =>
    '<tr><td>' + w.worker_id + '</td><td>' + timeAgo(w.last_seen_at) + '</td></tr>'
  ).join('') || '<tr><td colspan="2" class="empty">niciun worker conectat inca</td></tr>';
}

document.getElementById('newJobForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const account_id = document.getElementById('accountSelect').value;
  const text = document.getElementById('jobText').value;
  if (!account_id || !text) return;
  await fetch('/debug/delivery-job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_id, text }),
  });
  refresh();
});

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const segments = url.pathname.split("/").filter(Boolean);

  // Demo dashboard: a static page, not part of the worker API contract.
  // Track A's real /admin/social UI replaces this once it exists.
  if (req.method === "GET" && segments.length === 0) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(DASHBOARD_HTML);
  }

  // Debug endpoints: no auth, for demo visibility/control only.
  if (segments[0] === "debug") {
    if (req.method === "GET" && segments[1] === "state") {
      return send(res, 200, {
        accounts: [...state.accounts.values()],
        deliveryJobs: [...state.deliveryJobs.values()],
        generationRequests: [...state.generationRequests.values()],
        workers: [...state.workers.values()],
      });
    }
    if (req.method === "POST" && segments[1] === "account") {
      // Register the REAL Postiz integration id so a delivery job can
      // publish for real, instead of the fake seeded "mock-devto-1".
      const body = await readBody(req);
      const id = seedAccount({
        platform: body.platform,
        display_name: body.display_name || body.platform,
        postiz_integration_id: body.postiz_integration_id,
      });
      return send(res, 201, { account_id: id });
    }
    if (req.method === "POST" && segments[1] === "generation-request") {
      const body = await readBody(req);
      const id = seedGenerationRequest({
        brand: body.brand || "the-crypto-support",
        input: body.input,
      });
      return send(res, 201, { request_id: id });
    }
    if (req.method === "POST" && segments[1] === "delivery-job") {
      const body = await readBody(req);
      const id = seedDeliveryJob({
        accountId: body.account_id,
        text: body.text,
        scheduledAt: body.scheduled_at || new Date().toISOString(),
      });
      return send(res, 201, { job_id: id });
    }
    return send(res, 404, { error: "not found" });
  }

  // Everything under /api/worker/social/v1 requires the worker bearer token.
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${WORKER_TOKEN}`) {
    return send(res, 401, { error: "unauthorized" });
  }
  touchWorker(req);

  const prefix = "/api/worker/social/v1";
  if (!url.pathname.startsWith(prefix)) {
    return send(res, 404, { error: "not found" });
  }
  const route = url.pathname.slice(prefix.length);
  const body = req.method === "POST" ? await readBody(req).catch(() => ({})) : {};

  // --- Deliveries ---
  if (route === "/deliveries/claim" && req.method === "POST") {
    const limit = body.limit || 5;
    const now = Date.now();
    const due = [...state.deliveryJobs.values()]
      .filter((j) => j.status === "queued" && new Date(j.run_at).getTime() <= now)
      .slice(0, limit);
    for (const job of due) {
      job.status = "claimed";
      job.attempt_no += 1;
      job.lease_expires_at = new Date(now + 10 * 60_000).toISOString();
    }
    return send(res, 200, {
      jobs: due.map((j) => ({
        job_id: j.job_id,
        kind: j.kind,
        attempt_no: j.attempt_no,
        lease_expires_at: j.lease_expires_at,
        run_at: j.run_at,
        account: j.account,
        destination: j.destination,
        media: j.media,
        postiz: j.postiz || null,
      })),
    });
  }

  const deliveryMatch = route.match(/^\/deliveries\/([^/]+)\/(heartbeat|submitting|submitted|result)$/);
  if (deliveryMatch && req.method === "POST") {
    const [, jobId, action] = deliveryMatch;
    const job = state.deliveryJobs.get(jobId);
    if (!job) return send(res, 404, { error: "job not found" });

    if (action === "heartbeat") {
      job.lease_expires_at = new Date(Date.now() + 10 * 60_000).toISOString();
      return send(res, 200, { lease_expires_at: job.lease_expires_at });
    }
    if (action === "submitting") {
      job.status = "submitting";
      return send(res, 200, {});
    }
    if (action === "submitted") {
      job.status = "submitted";
      job.postiz = { post_id: body.postiz_post_id, group: body.postiz_group };
      return send(res, 200, {});
    }
    if (action === "result") {
      const { outcome, remote_url, error_code, error_message } = body;
      if (outcome === "published") {
        job.status = "published";
        job.remote_url = remote_url;
      } else if (outcome === "retry" || outcome === "reconciling") {
        job.status = outcome === "reconciling" ? "reconciling" : "queued";
      } else {
        job.status = "failed";
        job.last_error_code = error_code;
        job.last_error_message = error_message;
      }
      console.log(
        JSON.stringify({ msg: "delivery result", jobId, outcome, remote_url, error_code }),
      );
      return send(res, 200, {});
    }
  }

  // --- Generation ---
  if (route === "/generation/claim" && req.method === "POST") {
    const next = [...state.generationRequests.values()].find((r) => r.status === "queued");
    if (!next) return send(res, 200, { requests: [] });
    next.status = "running";
    next.lease_expires_at = new Date(Date.now() + 10 * 60_000).toISOString();
    return send(res, 200, {
      requests: [
        {
          request_id: next.request_id,
          brand: next.brand,
          input: next.input,
          lease_expires_at: next.lease_expires_at,
        },
      ],
    });
  }

  const draftsMatch = route.match(/^\/generation\/([^/]+)\/drafts$/);
  if (draftsMatch && req.method === "POST") {
    const req_ = state.generationRequests.get(draftsMatch[1]);
    if (!req_) return send(res, 404, { error: "request not found" });
    req_.status = "done";
    req_.drafts = body.drafts || [];
    console.log(
      JSON.stringify({
        msg: "drafts received",
        requestId: draftsMatch[1],
        count: req_.drafts.length,
      }),
    );
    return send(res, 200, { created: req_.drafts.length, skipped: 0 });
  }

  const failedMatch = route.match(/^\/generation\/([^/]+)\/failed$/);
  if (failedMatch && req.method === "POST") {
    const req_ = state.generationRequests.get(failedMatch[1]);
    if (!req_) return send(res, 404, { error: "request not found" });
    req_.status = "failed";
    req_.error_code = body.error_code;
    req_.error_message = body.error_message;
    return send(res, 200, {});
  }

  // --- Account sync ---
  if (route === "/accounts/sync" && req.method === "POST") {
    console.log(
      JSON.stringify({ msg: "accounts synced", count: (body.integrations || []).length }),
    );
    return send(res, 200, {});
  }

  return send(res, 404, { error: "not found", route });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(JSON.stringify({ msg: "mock-site listening", port: PORT }));
});
