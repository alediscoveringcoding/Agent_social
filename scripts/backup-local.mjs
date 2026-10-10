#!/usr/bin/env node
// Backs up (1) site/.local-db (PGlite data + private storage; the site must be
// stopped) and (2) the Postiz database via docker, into
// ~/agent-social-backups/<timestamp>/. Override for tests: LOCAL_DB_DIR (source)
// and BACKUP_ROOT (destination).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, openSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import net from "node:net";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbDir = process.env.LOCAL_DB_DIR || join(root, "site", ".local-db");
const backupRoot = process.env.BACKUP_ROOT || join(homedir(), "agent-social-backups");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backupDir = join(backupRoot, timestamp);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.setTimeout(1000, () => (s.destroy(), resolve(false)));
  });
}

/** Returns a reason string when the local database must not be copied now, else null. */
async function dbInUse() {
  const lock = join(dbDir, "owner.pid");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8").trim());
    if (pid && pid !== process.pid && pidAlive(pid)) return `process ${pid} holds the lock (${lock})`;
  }
  // Without an override the site is expected on port 3000.
  if (!process.env.LOCAL_DB_DIR && (await portBusy(3000))) return "something is listening on port 3000 (the site)";
  return null;
}

let siteSaved = null;
let siteFailed = false;
let postizSaved = null;
let postizSkipped = null;

console.log(`Backup folder: ${backupDir}\n`);

// 1. Local site database.
if (!existsSync(dbDir)) {
  console.log(`Site database: ${dbDir} does not exist, nothing to copy.`);
} else {
  const busy = await dbInUse();
  if (busy) {
    console.error(`Site database NOT backed up: it is in use (${busy}). Stop the site (and worker), then run this again.`);
    siteFailed = true;
  } else {
    try {
      mkdirSync(backupDir, { recursive: true });
      const dest = join(backupDir, "local-db");
      cpSync(dbDir, dest, { recursive: true });
      rmSync(join(dest, "owner.pid"), { force: true });
      siteSaved = dest;
      console.log(`Site database saved: ${dbDir} -> ${dest}`);
    } catch (err) {
      console.error(`Site database backup FAILED: ${err.message}`);
      siteFailed = true;
    }
  }
}

// 2. Postiz database.
function dockerOut(args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
let postizRunning = false;
let dockerProblem = null;
try {
  postizRunning = dockerOut(["ps", "--filter", "name=^postiz-postgres$", "--format", "{{.Names}}"]).trim() === "postiz-postgres";
} catch (err) {
  dockerProblem = err.code === "ENOENT" ? "docker is not installed or not on PATH" : "docker is not reachable";
}
if (!postizRunning) {
  postizSkipped = dockerProblem || "container postiz-postgres is not running";
} else {
  mkdirSync(backupDir, { recursive: true });
  const file = join(backupDir, "postiz.sql");
  const fd = openSync(file, "w");
  try {
    execFileSync("docker", ["exec", "postiz-postgres", "pg_dump", "-U", "postiz-user", "postiz-db"], {
      stdio: ["ignore", fd, "pipe"],
    });
    closeSync(fd);
    if (statSync(file).size === 0) throw new Error("pg_dump produced an empty file");
    postizSaved = file;
    console.log(`Postiz database saved: ${file}`);
  } catch (err) {
    try { closeSync(fd); } catch {}
    rmSync(file, { force: true });
    console.error(`Postiz dump FAILED (empty file removed): ${err.message.split("\n")[0]}`);
    process.exitCode = 1;
  }
}

if (postizSkipped) {
  if (siteSaved) {
    console.log(`Postiz skipped: ${postizSkipped}.`);
  } else {
    console.error(`WARNING: Postiz not backed up: ${postizSkipped}.`);
    process.exitCode = 1;
  }
}
if (siteFailed) process.exitCode = 1;

console.log("");
if (siteSaved || postizSaved) {
  console.log("Saved:");
  if (siteSaved) console.log(`  site database  ${siteSaved}`);
  if (postizSaved) console.log(`  Postiz dump    ${postizSaved}`);
}
if (process.exitCode) console.error("Backup finished WITH PROBLEMS (see above).");
else console.log(`Backup complete: ${backupDir}`);
