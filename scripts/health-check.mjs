#!/usr/bin/env node

async function check(name, url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { name, status: "UP", code: res.status };
  } catch (err) {
    return { name, status: "DOWN", error: err.message };
  }
}

async function main() {
  console.log("=== Health Check ===\n");
  const checks = await Promise.all([
    check("Postiz", "http://localhost:4007"),
    check("Temporal UI", "http://localhost:8080"),
    check("Mock site", "http://localhost:3000/debug/state"),
    check("Worker", "http://127.0.0.1:8787/health"),
  ]);

  for (const c of checks) {
    const icon = c.status === "UP" ? "OK" : "DOWN";
    console.log(
      `  ${icon} ${c.name}: ${c.status}${c.code ? ` (${c.code})` : ""}${c.error ? ` - ${c.error}` : ""}`,
    );
  }
}

main();
