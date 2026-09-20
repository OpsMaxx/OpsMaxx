# addy, the client half

> **Status: implemented and reviewed, 2026-09-20.** `docs/plans/addy.md` is the
> design of record and is frozen; this is the record of building the client
> against it — what shipped, what was found to be wrong on the way, and what is
> still open. Where the two disagree about what the code does, this file is
> right, because it was written afterwards.
>
> **Revised after review.** Three independent passes — security, correctness and
> user experience — found thirty-one defects in what this document had already
> called finished, four of them critical. Every one is fixed; §2 and §3 are
> rewritten around what they found, and §7 is new. The first draft of this file
> is wrong about how much was working and is corrected in place rather than
> quietly edited, because the size of the gap between "tests green" and "works"
> is the most useful thing here.

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

**Implemented, typechecking, unit-tested, and reachable from nowhere.** Twelve
times, in one feature. Six were found by building; six more by the review.

| What | How it was dead |
|---|---|
| `addySession.attach()` | zero callers — no session ever resumed |
| Relay login | described in a comment, implemented nowhere |
| `updateClipboardShortcuts` | zero callers — the shortcuts were never registered |
| `addyTarget` | no `kind: 'addy'` destination existed to open it |
| `answerPeer` | zero callers — so no device ever answered a dial |
| `isOwnEcho` | armed on every receive, read by nothing |
| `runRevocationWipe` | zero callers — **a stolen laptop was never wiped** |
| The roster `Pin` | accepted by the sidecar, never supplied — rollback undetectable |
| `Handoff.Adopt` | the four checks that make a re-key mean anything, called only by its own tests |
| `seenCounter` | passed as `0` at three sites, disabling the anti-rollback check |
| `protocol.Signal` | the DTLS fingerprint was never signed — **the relay was a MITM on every direct connection** |
| `forgetAddySecret` | zero callers — a re-key never shrank the blast radius it existed to shrink |

None of these is visible to a typechecker: a function nobody calls compiles
perfectly. None is visible to a unit test either, because each unit did what it
promised — and four of them had a *dedicated test file* that made them look
shipped. `tests/addyRevokeWipe.test.ts` is 180 lines exercising a wipe nothing
could start.

**Three shapes hid them**, and they are worth naming separately:

1. **A graceful fallback with no way to tell it from the good path.**
   `tryDirect` failed and the mailbox took over, so a path that could not
   succeed on any network looked exactly like one that was merely unavailable.
2. **A test that exercises the control directly.** The Go suite tested
   `Handoff.Adopt`, the `Pin` and the wipe adversarially and thoroughly.
   Nothing asserted that a production path reached them.
3. **A comment asserting the property.** Five comments in this module described
   a control the code no longer had — recovery catching truncation, a revoked
   device wiping itself, the DTLS fingerprint being signed, the TLS pin being
   noticed on reconnect, "never a key over the pipe". Each reads as a completed
   control to anyone auditing by reading, which is how four of them survived.

`tests/addyStatusWired.test.ts` is the guard: 67 assertions walking the source
of each layer and failing when a name appears in one and not the next. Crude on
purpose — it proves a name is present, not that the call is right — because the
failure it catches is "nothing anywhere mentions this".

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
   opening and signing all went on working, and only operations using the AK
   itself as a binding broke — weeks after the load that caused it.
4. **Request signatures were over the escaped path; the relay verifies the
   decoded one.** Invisible while every object name was alphanumeric. The first
   name with a colon in it returned a 401 that reads exactly like a bad token.
5. **A rotation locked every other device out.** Handoffs were published and
   nothing read them.
6. **A rotation also broke recovery**, until the escrow was re-sealed at the
   new epoch.
7. **A device pairing into a rotated account was bricked.** `pairAccept`
   returned whatever epoch key the handoff carried and called it
   `epoch1SignPub` — correct only for an account that has never rotated.

Two of these (3 and 4) were fixed in the `addy` repository first and vendored
here, per `sidecar/addyd/protocol/VENDORED.md`.

**One thing the review got wrong, corrected by measurement.** It reported that
an unconditional PUT is last-write-wins, so two devices creating the same
collection lose one silently. Probed against a running relay: the second PUT
returns 409. `ErrObjectExists` is deliberately distinct from `ErrETagMismatch`,
and the store's own test asserts it. Reading `relay.putObject` — which only
sends `If-Match` when given one — and inferring the server's behaviour from it
is the same mistake as trusting a comment.

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
- **`Handoff.Adopt` cannot verify a chain past epoch 1.** It passes
  `epoch1 = nil` to the verifier for any later epoch, and nothing in a chain
  ever establishes AK_1's signing key — epoch 1 is the genesis, so no
  transition entry names it. So the helper written to make a rotation safe
  cannot be used on an account that has rotated. Its four checks are
  reproduced in `handleAdoptEpoch`, where the pinned epoch-1 key is in hand.
  **The limitation belongs upstream and is recorded rather than patched in a
  vendored copy.**
- **A recovering device cannot fully detect a rollback.** The chain is pinned
  against the escrow's head, and the relay chooses which escrow to serve. An
  escrow one epoch past the chain's end is proof of a rotation and is refused,
  so the relay must hide that too — and hiding it breaks recovery visibly for
  anyone who really did re-key. That is a bound, not a cure: a device
  recovering from nothing has no prior state to compare against, which is why
  the design's printable card carries the roster head and the device count.
  **The person is the last check.**
- **The signalling `from` is proven, the mail `fromDevice` is not.** A session
  description is signed, so naming another device produces a signature that
  does not verify. A mailbox row's sender is the relay's own column: inbound
  mail is filtered to current roster members, which stops a removed device
  delivering under its own identity, but a relay can still relabel a row
  between two current members.

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

## 7. What the review changed, and what it cost to find

Three parallel passes over a feature this document had already called
finished: an adversarial security review of the sidecar and the client against
the stated threat model, a correctness review of the sync engine, and a
user-experience review of the six screens. They found **thirty-one defects**,
four of them critical, and every one is fixed.

The distribution is the interesting part.

| Where | Found | Worst |
|---|---|---|
| Security | 4 critical, 2 high, 5 low | Arbitrary file write from a decrypted notice; a revoked device sealing itself the next epoch key |
| Correctness | 3 critical, 4 high, 6 medium | A conflict written to disk, reverted by the renderer, then pushed back as the winner |
| User experience | 1 catastrophic, 2 severe, 11 lesser | The recovery phrase unmounted mid-write by the app itself |

**Not one of them was caught by 10,000 passing tests.** That is the number
worth carrying forward, and the reason is in §2: the suite tested units, and
every unit did what it promised.

Two findings were the reviews' own errors, and both were settled by measuring
rather than arguing — an unconditional PUT (§3) and the direction of the
conflict-resolution bug, which was reported as "overwrites the winner" and is
actually "nothing is written at all, ever". A reviewer reading `putObject` and
inferring the server's behaviour is making the same move as a reader trusting
a comment, and it deserves the same answer: ask the running thing.

**Two of my own tests were vacuous**, found by mutating the code they guarded
and watching nothing fail. Both have been rewritten to drive the real path.
Every security-relevant guard added in this work has since been mutation-
checked the same way: break it, confirm a test fails, put it back. That is now
the standard in this module, not a spot check.

## 8. Provenance

Built 2026-09-20 against a relay binary compiled from the `addy` repository and
run in `-dev` mode on loopback. Every claim in §1 was produced by one of two
harnesses driving real `addyd` sidecars over real NDJSON and real HTTP: one
covering pair → sync → clipboard → transfer → revoke, the other covering
recover → re-key → recover again. Both print each step and fail loudly.

Reviewed the same day by three independent passes, and rebuilt against what
they found — see §7.

The Go suite is 222 tests across four packages; the TypeScript suite is 10,169.
Every guard added in this work was checked by mutating the code it protects and
confirming a test fails; two that did not were rewritten. The counts are
recorded because a number in a document goes stale silently, and because they
are the number that was green while twelve controls were unreachable.
