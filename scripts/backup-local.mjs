#!/usr/bin/env node
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backupDir = join(homedir(), "agent-social-backups", timestamp);
mkdirSync(backupDir, { recursive: true });

console.log(`Backing up to ${backupDir}\n`);

try {
  console.log("Dumping Postiz database...");
  execSync(`docker exec postiz-postgres pg_dump -U postiz-user postiz-db > "${join(backupDir, "postiz.sql")}"`, {
    stdio: "inherit",
    shell: true,
  });
  console.log("  Done");
} catch (err) {
  console.error("  Failed:", err.message);
}

console.log(`\nBackup complete: ${backupDir}`);
