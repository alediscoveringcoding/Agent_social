#!/usr/bin/env node
// Required: the site and the worker. Optional: the Postiz stack (docker).
// Exits 1 when a required service is down.

async function check(name, url, required) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    const up = res.ok;
    return { name, required, up, code: res.status, error: up ? "" : `HTTP ${res.status}` };
  } catch (err) {
    return { name, required, up: false, error: err.cause?.code || err.message };
  }
}

const checks = await Promise.all([
  check("Site", "http://127.0.0.1:3000/login", true),
  check("Worker", "http://127.0.0.1:8787/health", true),
  check("Postiz", "http://127.0.0.1:4007", false),
  check("Temporal UI", "http://127.0.0.1:8080", false),
]);

console.log("=== Health Check ===\n");
for (const c of checks) {
  const tag = c.required ? "required" : "optional";
  console.log(`  ${c.up ? "OK  " : "DOWN"} ${c.name} (${tag}): ${c.up ? `UP (${c.code})` : `DOWN - ${c.error}`}`);
}
if (checks.some((c) => c.required && !c.up)) {
  console.error("\nA required service is down.");
  process.exitCode = 1;
}
