#!/usr/bin/env node
// Launch a development build against a throwaway synthetic-data profile.
//
//   npm run demo                 poke around the invented estate by hand
//   npm run demo:shots [outdir]  also walk the screens and save the site's
//                                screenshots, then quit (default ./out/shots)
//
// The profile is wiped and re-seeded every run, so a shot never depends on what
// the last run left behind. It lives in the OS temp dir and never in the real
// profile: src/main/demoGuard.ts refuses that path outright, because seeding
// writes the data file, the vault and the audit chain.
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const shots = process.argv[2] === '--shots'
const outdir = shots ? resolve(process.argv[3] ?? 'out/shots') : ''
const profile = join(tmpdir(), 'opsmaxx-demo-profile')

rmSync(profile, { recursive: true, force: true })

const env = {
  ...process.env,
  OPSMAXX_DEMO_PROFILE: profile,
  ...(shots ? { OPSMAXX_DEMO_CAPTURE: outdir } : {})
}
const child = spawn('npx', ['electron-vite', 'dev'], { stdio: 'inherit', env, shell: process.platform === 'win32' })
child.on('exit', (code) => process.exit(code ?? 0))
