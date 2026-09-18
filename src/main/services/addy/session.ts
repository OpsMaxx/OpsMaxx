import { AddyError, openAddyd, type AddySidecar } from './sidecar'
import { RelayClient } from './relay'
import {
  discardConflict,
  listConflicts,
  resolveConflict,
  type ConflictDeps
} from './conflicts'
import type { ConflictCopy } from '../../../shared/addy'

/**
 * The live connection to an addy account: one sidecar, one relay client.
 *
 * NOTHING HERE IS CONFIGURED YET, and every entry point says so rather than
 * failing obscurely. Pairing is what fills this in, and until it does, the
 * honest answer to "what conflicts are waiting" is "none, because this device
 * is not attached to an account" -- not an exception the renderer has to
 * recognise, and not an empty list that looks like everything is fine.
 */

export interface AddyAccount {
  baseURL: string
  token: string
  accountId: string
  epoch: number
}

class AddySession {
  private addyd: AddySidecar | null = null
  private relay: RelayClient | null = null
  private account: AddyAccount | null = null

  /** True once a device is attached to an account and the sidecar is up. */
  get attached(): boolean {
    return this.account !== null && this.addyd !== null && this.addyd.alive()
  }

  /** Starts the sidecar and hands it the key material.
   *
   *  The KEYS are passed in rather than read here, because reading them means
   *  touching the keychain and this module has no business doing that -- the
   *  addy key store is one builder and one place, and a second reader is a
   *  second thing to forget to exclude from a backup. */
  async attach(
    account: AddyAccount,
    keys: { deviceSignSeed: string; deviceEncKey: string; epochKeys: Record<number, string> },
    log?: (line: string) => void
  ): Promise<void> {
    await this.detach()
    const addyd = await openAddyd(log)
    await addyd.send('load', {
      accountId: account.accountId,
      deviceSignSeed: keys.deviceSignSeed,
      deviceEncKey: keys.deviceEncKey,
      epochKeys: keys.epochKeys
    })
    this.addyd = addyd
    this.relay = new RelayClient({ baseURL: account.baseURL, token: account.token }, addyd)
    this.account = account
  }

  /** Stops the sidecar and forgets everything. Called when the vault locks and
   *  at quit: nothing addyd holds is on disk, so stopping it IS the
   *  remediation rather than a step towards one. */
  async detach(): Promise<void> {
    const held = this.addyd
    this.addyd = null
    this.relay = null
    this.account = null
    await held?.close()
  }

  private deps(): ConflictDeps {
    if (!this.addyd || !this.relay || !this.account) {
      throw new AddyError('not-paired', 'this device is not attached to an addy account')
    }
    return { addyd: this.addyd, relay: this.relay, epoch: () => this.account!.epoch }
  }

  /** Empty rather than throwing when unattached.
   *
   *  The renderer calls this on mount, on every window, before the user has
   *  been anywhere near addy. An exception there would be an error dialog for
   *  a feature nobody has turned on. */
  async conflicts(): Promise<ConflictCopy[]> {
    if (!this.attached) return []
    return listConflicts(this.deps())
  }

  async resolveConflict(id: number, collection: string, chosen: unknown): Promise<void> {
    // The counter comes from the winning object's own, plus one. Deriving it
    // here rather than taking it from the renderer keeps the anti-rollback
    // control out of reach of anything a page could influence.
    const deps = this.deps()
    const stored = await deps.relay.getObject(collection, deps.epoch())
    let counter = 1
    if (stored) {
      const opened = await deps.addyd.send<{ counter: number }>('open', {
        collection,
        epoch: deps.epoch(),
        sealed: stored.body.toString('base64'),
        knownSchema: 1,
        seenCounter: 0
      })
      counter = opened.counter + 1
    }
    await resolveConflict(deps, id, collection, chosen, counter)
  }

  async discardConflict(id: number): Promise<void> {
    await discardConflict(this.deps(), id)
  }
}

export const addySession = new AddySession()
