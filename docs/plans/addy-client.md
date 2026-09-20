# addy, the client half

> **Status: implemented, 2026-09-20.** `docs/plans/addy.md` is the design of
> record and is frozen; this is the record of building the client against it —
> what shipped, what was found to be wrong on the way, and what is still open.
> Where the two disagree about what the code does, this file is right, because
> it was written afterwards.

## 1. What exists now

Every one of these was driven end to end against a real relay built from the
`addy` repository, with real sidecars over the real NDJSON protocol. None of it
is asserted from a mock alone.

| Capability | Where | Proven by |
|---|---|---|
| Mint an account, register, log in | `session.ts`, `relay.ts` | e2e: token issued |
| Pair a second device (SPAKE2 + 7 emoji) | `pairing.ts`, `PairingPanel.tsx` | e2e: both devices derive the same emoji |
| Complete the pairing — handoff, roster entry | `session.ts` `completePairing`/`finishJoin` | e2e: 2 devices on a verified chain |
| Sync 14 collections, LWW with conflict copies | `sync.ts`, `collections.ts` | e2e: a collection carried between two devices |
| Clipboard, explicit send and receive | `clipboard.ts` | e2e: a string delivered through the mailbox |
| File transfer, pointer + object store | `transfer.ts` | e2e: 11,600 bytes, digest verified |
| Remove a device | `session.ts` `revokeDevice` | e2e: the removed device sees itself absent |
| Re-key (epoch rotation) | `session.ts` `rotateEpoch` | e2e: re-keyed, and recovered again afterwards |
| Follow somebody else's rotation | `session.ts` `followRotation` | Go: a second device reads the new epoch |
| Recover from the 12-word phrase | `session.ts` `recoverFromPhrase` | e2e: account and estate recovered from the card alone |
| Back up to the relay | `target.ts` + `backupTargets.ts` | `tests/addyTarget.test.ts` |
| The status panel | `AddyPanel.tsx`, `addyStatus.ts` | `tests/addyPanel.test.tsx` |

## 2. The defect this module kept producing

**Implemented, typechecking, unit-tested, and reachable from nowhere.** Seven
separate times, in one feature:

| What | How it was dead |
|---|---|
| `addySession.attach()` | zero callers — no session ever resumed |
| Relay login | described in a comment, implemented nowhere |
| `updateClipboardShortcuts` | zero callers — the shortcuts were never registered |
| `addyTarget` | no `kind: 'addy'` destination existed to open it |
| `answerPeer` | zero callers — so no device ever answered a dial |
| `isOwnEcho` | armed on every receive, read by nothing |
| The revocation actor side | the victim half existed; nothing authored the entry |

None of these is visible to a typechecker: a function nobody calls compiles
perfectly. None is visible to a unit test either, because each unit did what it
promised.

**What hid three of them was a graceful fallback.** `tryDirect` failed and the
mailbox took over, so a path that could not succeed on any network looked
exactly like a path that was merely unavailable. That is the general lesson
worth keeping: *a degradation with no way to tell it from the good path will
hide a dead feature indefinitely.*

`tests/addyStatusWired.test.ts` is the guard. It walks the source text of each
layer and fails when a name appears in one and not the next. Crude on purpose —
it proves a name is present, not that the call is right — because the failure it
catches is "nothing anywhere mentions this", which is the one that got through
seven times.

## 3. Bugs found by running it, not by reading it

Each of these passed review and a green suite.

1. **`verifyRoster` returned `H(last entry)`; `addDevice` and `pairHandoff`
   both need the entry itself.** Pairing died one step *after* the emoji
   matched — the worst possible place, because the user has already been told
   the two devices agree.
2. **The handoff frame carried the sealed blob alone.** The joiner needs the
   epoch, counter and account id back to open it, and can derive none of them.
3. **`DeriveEpoch` kept the caller's buffer as `EpochKeys.AK`**, and `load`
   wipes that buffer afterwards — which is the right thing for a caller to do.
   So every *resumed* device held an all-zero AK. Silent and delayed: every key
   derived from the AK is computed during the load and is correct, so sealing,
   opening and signing went on working, and only operations using the AK itself
   as a binding broke — weeks later, on a machine that had been fine.
4. **Request signatures were over the escaped path; the relay verifies the
   decoded one.** Invisible while every object name was alphanumeric. The first
   name with a colon in it returned a 401 that reads exactly like a bad token.
5. **A rotation locked every other device out.** Handoffs were published and
   nothing read them.
6. **A rotation also broke recovery**, until the escrow was re-sealed at the new
   epoch: the card would have gone on opening a key the account had moved off.

Two of these (3 and 4) were fixed in the `addy` repository first and vendored
here, per `sidecar/addyd/protocol/VENDORED.md`.

## 4. Decisions worth the ink

**Sync is core, not a module.** It imports `services/vault` and
`services/secrets`, both in `MODULE_FORBIDDEN_IMPORTS`. A module would have
turned `main` red on its first commit, and the precedent is right anyway — VPN,
tunnels and backup are not modules either.

**Neither optional surface became a registered module.** The clipboard is gated
by a setting, because what it actually costs is two global shortcuts taken from
every application on the machine, and that warning has to live where the switch
is; a module toggle in Settings plus a warning on the panel would be two
switches for one thing, and the one people find would be the one without the
warning. Transfer is a row on a panel already behind the `addy` module.
`ADDY_MODULE_IDS` is kept as the record of that decision, because "we decided
against it" and "nobody got to it" look identical once the names are gone.

**A collection's source is a registry, not a `switch`.** A `default: break`
makes "nobody wired this" identical to "deliberately left out" — and here the
first means a collection that silently never syncs, with no error, until
somebody notices their databases never reached the second laptop. Every name in
`SYNCED_COLLECTIONS` must appear in `SOURCES` or in `PENDING` with a reason, and
a test fails the build otherwise.

**The renderer owns eleven of the sixteen collections in memory**, and rewrites
the whole blob 400ms after any change. So an inbound copy written to that file
and not announced is undone by the next keystroke. `data:external-change` names
which collections landed and the store reloads exactly those — not tabs, panes
or the active workspace, which are device-local on purpose and would rearrange
somebody's screen because another machine added a server.

**A device cannot revoke itself**, refused in the sidecar as well as hidden in
the panel. It would wipe the machine the user is sitting at, one press away, on
a list where one row says "This device" — and a guard that lives only in the UI
is one any other caller skips.

**A hygiene rotation refuses a recovery phrase it does not need.** Accepting one
would teach people to type the phrase for routine work, and a phrase typed often
is a phrase that ends up somewhere.

**Recovery ends on a device review, not on "done".** Anyone who has read the
card can do exactly what was just done, and the moment a person is most able to
notice a device they do not recognise is the moment they have just been handed
the list.

## 5. What is deliberately not here

- **The relay does not check that a rotation re-sealed everything.** The design
  asks for it; `internal/api/resources.go` in the `addy` repository checks
  contiguity and nothing else. The client does the re-sealing in the normative
  order and a test pins that order, but a client that did not would not be
  caught. **This belongs in the server repo and is not fixed.**
- **No object DELETE.** The relay serves `GET` and `PUT` for objects, so a
  collected transfer's bytes stay until quota pressure or an epoch rotation.
  Transfers are size-capped partly for that reason.
- **p2p is one message per connection.** The dialling side closes as soon as the
  payload is away, and the answering side reads one payload. Enough for a
  clipboard; a file goes through the object store instead.
- **`manifest` and `deviceNames` have no local store.** Both are named in the
  protocol and declared `PENDING` with the reason. `deviceNames` needs a rename
  affordance that does not exist; `manifest` is M6 work whose format was
  designed early so that arriving needs no protocol change.

## 6. Open questions for the owner

1. **Should the `addy` module be on for existing installs?** `backfillModules`
   leaves a new module off on upgrade — "an upgrade is not consent" — so every
   install that predates this gets it switched off and has to find it in
   Settings. That is the documented behaviour and it is deliberate; it is raised
   because addy is more discoverable-by-accident than most and the answer may
   genuinely be different. **Not changed.**
2. **Is a one-message-per-connection p2p path worth keeping at all**, given the
   mailbox works and is store-and-forward? It is cheaper to keep than to rebuild
   later, but it is the least exercised code in the module.
3. **The relay's missing rotation-completeness check** (§5) — client-side care
   is not the same as an enforced invariant, and the design says the server
   should refuse.

## 7. Provenance

Built 2026-09-20 against a relay binary compiled from the `addy` repository and
run in `-dev` mode on loopback. Every claim in §1 was produced by one of two
harnesses driving real `addyd` sidecars over real NDJSON and real HTTP: one
covering pair → sync → clipboard → transfer → revoke, the other covering
recover → re-key → recover again. Both print each step and fail loudly.

The Go suite is 219 tests across four packages; the TypeScript suite is 10,101.
Every test written for a security property in this work was checked by mutating
the code it guards and confirming it fails.
