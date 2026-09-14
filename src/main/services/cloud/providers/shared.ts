/** Helpers the three brokers share. Nothing provider-specific lives here. */

import { createServer } from 'node:net'
// ssh2 is CommonJS, and `utils` is an object literal inside its `module.exports`
// rather than a plain binding, so cjs-module-lexer does not see it as a named
// export. The main bundle is ESM, so `import { utils } from 'ssh2'` type-checks,
// passes every test under Vitest's resolver, and then throws SyntaxError the
// moment the packaged app starts. Default-import and destructure instead.
import ssh2 from 'ssh2'

import { CloudError } from '../../../../shared/cloud'

const { utils } = ssh2

/**
 * A keypair that exists for one connection.
 *
 * This is what lets the AWS and GCP paths avoid storing anything: the public
 * half is published to the provider with a short time limit, the private half
 * never leaves this process, and both are forgotten when the connection ends.
 * Nothing reaches the secrets store, because there is nothing worth keeping.
 */
export interface EphemeralKeyPair {
  publicKey: string
  privateKey: string
}

export function generateEphemeralKey(): EphemeralKeyPair {
  const pair = utils.generateKeyPairSync('ed25519')
  return { publicKey: pair.public.toString(), privateKey: pair.private.toString() }
}

/**
 * Ask the OS for a port nobody is using.
 *
 * Inherently a little racy - the port is free when we look and claimed by the
 * time the tunnel binds it, in principle. The alternative is a fixed port,
 * which races every other tunnel on the machine every time instead of
 * occasionally. Where a provider can choose its own port and tell us (gcloud
 * can), we let it, and this is not used.
 */
export async function freeLocalPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

/** Refuse early when the machine is off, with a message that says so. */
export function assertRunning(running: boolean, state: string): void {
  if (!running) {
    throw new CloudError('instance-stopped', state ? `It is reported as "${state}".` : undefined)
  }
}
