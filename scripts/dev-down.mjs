#!/usr/bin/env node
import { execSync } from "node:child_process";

function run(cmd, opts = {}) {
  console.log(`> ${cmd}`);
  try {
    execSync(cmd, { stdio: "inherit", ...opts });
  } catch {}
}

console.log("=== social-infra dev-down ===\n");
run("docker compose down", { cwd: "local" });
console.log("\nPostiz stack stopped. Stop the worker and mock-site with Ctrl+C in their terminals.");
