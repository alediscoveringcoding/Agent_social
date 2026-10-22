#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// Starts the site and the worker (scripts/dev-local.sh). npm and Node run in WSL/Linux only.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'linux') {
  console.error('Run from WSL: wsl.exe -e bash /mnt/r/Repos/Agent_social/scripts/dev-local.sh')
  process.exit(1)
}
const script = fileURLToPath(new URL('./dev-local.sh', import.meta.url))
const child = spawn('bash', [script, ...process.argv.slice(2)], { stdio: 'inherit' })
child.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
child.on('exit', (code) => { process.exitCode = code ?? 1 })
