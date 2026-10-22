#!/usr/bin/env node
import { readFileSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.platform !== 'linux') {
  console.error('Run this command inside WSL/Linux.'); process.exit(1);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const script = resolve(root, 'scripts/dev-local.sh');
try {
  const [rawPid, started] = readFileSync(resolve(root, '.local-run/dev.pid'), 'utf8').trim().split(/\s+/);
  if (!/^\d+$/.test(rawPid) || !/^\d+$/.test(started)) throw new Error('Invalid runtime PID file.');
  const pid = Number(rawPid);
  if (pid <= 1) throw new Error('Invalid runtime PID.');
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const actualStart = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  const cwd = readlinkSync(`/proc/${pid}/cwd`);
  const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  if (actualStart !== started || !args.some(arg => resolve(cwd, arg) === script)) throw new Error('The PID no longer belongs to this app.');
  process.kill(pid, 'SIGTERM');
  console.log('Stopping this app and its worker.');
} catch (error) {
  if (error.code === 'ENOENT' || error.code === 'ESRCH') console.log('No active app process was found.');
  else { console.error(error.message); process.exitCode = 1; }
}
