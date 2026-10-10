#!/usr/bin/env node
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const localDir = join(dirname(fileURLToPath(import.meta.url)), "..", "local");

console.log("=== social-infra dev-down ===\n");
const cmd = "docker compose down";
console.log(`> ${cmd}`);
try {
  execSync(cmd, { stdio: "inherit", cwd: localDir });
  console.log("\nPostiz stack stopped. Stop the site and worker with Ctrl+C in their terminals.");
} catch (err) {
  console.error(`\nFAILED: "${cmd}" did not succeed (${err.message.split("\n")[0]}). The Postiz stack may still be running.`);
  process.exitCode = 1;
}
