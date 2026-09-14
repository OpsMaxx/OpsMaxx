#!/usr/bin/env node
// A stand-in for gcloud / aws / az.
//
// A real spawnable script rather than a vi.mock, following fake-openvpn.mjs and
// fake-frpc.mjs next door: it proves the argv actually survives the process
// boundary, which a mocked execFile cannot. The scenario is chosen by
// FAKE_CLOUD_MODE so one script covers every case.
//
// It writes the argv it received to FAKE_CLOUD_ARGV_LOG when that is set, which
// is how the tests assert that no shell ever touched the arguments.

import { appendFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const mode = process.env.FAKE_CLOUD_MODE ?? 'ok'
const log = process.env.FAKE_CLOUD_ARGV_LOG

if (log) appendFileSync(log, JSON.stringify(argv) + '\n')

const out = (s) => process.stdout.write(s)
const err = (s) => process.stderr.write(s)

if (argv.includes('--version') || argv[0] === 'version') {
  // Each tool's real wording, because the version parsers are regexes over it.
  if (process.env.FAKE_CLOUD_KIND === 'aws') out('aws-cli/2.15.30 Python/3.11.6 Darwin/23.2.0\n')
  else if (process.env.FAKE_CLOUD_KIND === 'azure') out('{"azure-cli": "2.57.0"}\n')
  else out('Google Cloud SDK 458.0.1\nbq 2.0.101\n')
  process.exit(0)
}

switch (mode) {
  case 'ok':
    out(process.env.FAKE_CLOUD_STDOUT ?? '[]')
    process.exit(0)
    break
  case 'expired':
    err('ExpiredToken: The security token included in the request is expired\n')
    process.exit(255)
    break
  case 'denied':
    err("PERMISSION_DENIED: Required 'compute.instances.get' permission\n")
    process.exit(1)
    break
  case 'notfound':
    err("ERROR: The resource 'projects/x/zones/y/instances/z' was not found\n")
    process.exit(1)
    break
  case 'secret':
    // Used to prove the redaction layer runs before anything is reported.
    err('failed: Authorization: Bearer ya29.SUPERSECRETTOKENVALUE\n')
    process.exit(1)
    break
  default:
    err(`unknown FAKE_CLOUD_MODE ${mode}\n`)
    process.exit(2)
}
