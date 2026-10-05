#!/usr/bin/env node
// Cross-platform startup script. Starts the Postiz stack in order and
// prints a health summary. Run the worker and mock-site separately
// (see README) so their logs stay visible.

import { execSync } from "node:child_process";

const isWindows = process.platform === "win32";

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  try {
    execSync(cmd, { stdio: "inherit", ...opts });
    return true;
  } catch {
    return false;
  }
}

function checkPort(port) {
  try {
    const cmd = isWindows ? `netstat -an | findstr ":${port}"` : `lsof -i :${port} -t`;
    execSync(cmd, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log("=== social-infra dev-up ===");

  console.log("\n1. Checking Docker...");
  if (!run("docker info", { stdio: "ignore" })) {
    console.error("Docker is not running. Start Docker Desktop first.");
    process.exit(1);
  }
  console.log("   Docker OK");

  console.log("\n2. Starting Postiz stack...");
  run("docker compose up -d", { cwd: "local" });

  console.log("\n3. Waiting for Postiz to be ready...");
  let postizReady = false;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch("http://localhost:4007");
      if (res.ok || res.status < 500) {
        postizReady = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
    process.stdout.write(".");
  }
  console.log(postizReady ? "\n   Postiz ready" : "\n   Postiz not ready (check logs)");

  console.log("\n=== Health Summary ===");
  const services = [
    { name: "Postiz", url: "http://localhost:4007", port: 4007 },
    { name: "Temporal UI", url: "http://localhost:8080", port: 8080 },
  ];
  for (const svc of services) {
    const up = checkPort(svc.port);
    console.log(`  ${up ? "OK" : "DOWN"} ${svc.name} (${svc.url})`);
  }

  console.log(`\n  Next: node worker/test/mock-site.mjs   (until the real site exists)`);
  console.log(`        cd worker && npm run dev           (the worker)`);
  console.log(`  To stop: node scripts/dev-down.mjs`);
}

main().catch(console.error);
