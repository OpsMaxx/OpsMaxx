# Vault lock/unlock UX

> **Status: implemented, 2026-09-20.** Written from a four-way audit of the
> vault's state machine, every surface that touches it, the threat model as the
> code implements it, and the password-only path. §5.1, §5.2 and §5.3 are built;
> §7.1 and §7.2 are fixed. §6 is a decision to leave something alone. The open
> questions in §8 are still open, and two claims in the first draft were wrong
> and are corrected in place rather than quietly edited.

## 1. Executive summary

The request assumed people are asked for the master password constantly and
that this is why background work is blocked. **Measurement says the opposite.**
A password-only user is prompted **once per app launch — sometimes zero times**,
and the problem is that *nothing ever asks*.

At launch the vault is `locked`. VPN autostart, CI discovery, the fleet sampler
and scheduled backups all decline — correctly, an unattended run must not put a
dialog on screen — and then nothing raises the question. Those four sit dead
until the user happens to click something unrelated, which prompts once and
silently repairs all of them through `resumeChecksAfterUnlock`.

The codebase already says this about itself, in `store/backupRuns.ts:103`:

> nothing ever RAISES it after a launch… the user is never asked. So the
> convenience that was built to solve exactly this never got the chance to.

**The recommendation is therefore to ask once, at the right moment, with a
reason — and to build no new key mechanism.** An attacker gains *nothing* under
it: nothing new is stored, nothing new is derived, no key's lifetime changes.
That is the argument for it.

## 2. What the master password actually protects

One adversary, and it is the offline one.

| Adversary | Defended? | By what |
|---|---|---|
| The vault file at rest | **Yes** | AES-256-GCM under scrypt (`vault.ts:39`) |
| Code running as the user's OS account | No, deliberately, app-wide | `safeStorage` grants this process access with no prompt |
| Injection into the main process | No | `SECURITY.md` says the hardened runtime is what covers this, not the vault |
| Someone at an unattended unlocked machine | Partly | the `secured` stage drops the renderer's plaintext copy |

The distinction that matters: **the vault file is portable.** It travels inside
a `.spbackup`. `opsmaxx-secrets.json` does not, because `safeStorage` is machine
and user bound. So the master password buys secrecy for a credential *designed
to leave the machine*. That is real and worth keeping.

Against a live attacker on the running machine it adds close to nothing, and
`SECURITY.md` concedes this in its own words — the win is over **files**, not
over your **session**.

## 3. Where the problem actually is

`secured` never blocked anything. `vaultEntriesForResolve()` resolves at any
stage while a key and cache exist, and deliberately does not touch the idle
timer (`vault.ts:331-333`), so monitoring, CI polling, reconnects and scheduled
backups all keep running through the 15-minute idle transition.

The only blocking state is `locked`, reached from exactly four places:

- **app launch** — nothing auto-unlocks
- **machine suspend** (`index.ts:5864`)
- **quit**
- **explicit Lock now**

Screen lock deliberately only *secures* (`index.ts:5859`). Idle only *secures*.

**So the entire problem is cold start and post-suspend.** Not idle, and not the
steady-state UX.

## 4. What is blocked, and whether anyone is told

Corrected from the first draft of this document, which claimed all four were
silent. Three of four say something; one says nothing; and one surface nobody
had counted says nothing at all.

| Surface | In `locked` | Is the user told? |
|---|---|---|
| Scheduled backups | skips, classified as a *skip* not a failure | **Yes** — OS notification, but transition-only and up to `TICK_MS` (5 min) late |
| Fleet sampler | blocked targets skipped; all-blocked stops the timer | **Yes** — status-bar chip with an unlock action |
| CI/CD polling | throws, backs off, retries for ever; error never self-clears | **Panel only** — nothing global |
| Detached job polling | **parks** and resumes at the same byte offset | Yes |
| Credential proxy | parks and refuses; never forwards unauthenticated | Yes |
| VPN autostart | fails; id recorded for retry | **Panel only** — corrected, see below |
| **ssh-agent signing** | `identities()` returns `[]`; every signature refused | **No affordance at all** |

**Corrected again on implementation.** VPN autostart is not silent: its
vault-locked branch goes through `fail()`, which publishes `{state: 'error',
errorCode: 'vault-locked'}` to the renderer, and the VPN panel renders an
"Unlock vault" action that retries the start. It is panel-level, the same class
as CI — not the silent one this table first claimed. The `console.error` and
the in-memory Set are the *other* branch, for failures that are not the vault.

**ssh-agent was the only surface with no affordance anywhere, and it was worse
than silence.** `identities()` reads through `vaultEntriesForResolve`, which
answers nothing while locked, so every key vanished from the panel and it said
*"No SSH keys in the vault yet"* — telling the user to add keys they already
have, while `canSign()` refused every signature and `git push` fell back to
`~/.ssh` without explanation. Fixed: the panel now says the vault is locked,
that the keys are still there, and offers the unlock.

## 5. The recommendation

### 5.1 Ask once, at launch, naming what is waiting

If a vault exists and anything configured needs it unattended, raise **one**
prompt that says what is blocked — not four independent silences:

> VPN "office", 2 CI accounts, 4 monitored servers and a backup to
> "wasabi-nightly" are waiting on the vault.

`VAULT_LOCKED` is already a marker rather than a sentence (`shared/vault.ts:25`),
so every surface can contribute a count without any of them matching English.

Cost in the threat model of §2: **zero**. Nothing is stored, nothing derived, no
key outlives anything it already outlives. It changes *when a human is asked*,
not *what is protected*.

**DONE.** One prompt, once per launch, through the existing unlock dialog —
no new UI. Counted per surface: auto-starting VPN profiles with a vault ref
anywhere in the spec (scanned rather than enumerated per kind, so a new spec
kind cannot silently undercount), saved CI connections, scheduled backup
destinations that are not already machine-only, and the fleet sampler's own
`vaultBlockedCount`.

That last one is taken from the sampler rather than recomputed in main
deliberately: the sampler's number is hop-aware — a host behind a bastion whose
password is in the vault is blocked however readable its own credential is —
and scoped to the workspace actually being watched. Recomputing it would have
meant replicating the renderer's workspace resolution, which is a guess rather
than a count.

**Not raised again after suspend**, and this is a judgement worth recording
rather than a gap. The lock fires as the machine goes to *sleep*, so a dialog
raised then lands on a screen someone is walking away from and is stale by the
time they return; a person who has just woken a machine is at it, and the next
thing they touch carries its own unlock — which is precisely what is missing at
launch and not after a wake. A laptop suspends several times a day, and a
prompt on each is the nag this design rules out. The status-bar chip still says
what is paused. **Open question in §8 if that proves wrong in use.**

**ssh-agent is deliberately not counted.** It has no configured state to count
honestly — `identities()` returns `[]` and there is no "how many keys would
have been offered". §5.2 gave it an affordance instead, which is what it
needed.

### 5.2 Three small wires that are missing

- **Backup is not a member of `resumeChecksAfterUnlock`.** DONE — it is the
  fifth now, so a skipped destination runs on the unlock rather than up to five
  minutes later. Still the same due check: a destination that is not due does
  not run, and a skipped one was never marked as attempted so its schedule is
  intact.
- ~~**VPN autostart reports to nobody.**~~ Wrong — it reports to the VPN panel.
  See §4.
- **ssh-agent has no locked-state affordance.** DONE — it claimed the vault was
  empty. It now says the vault is locked and offers the unlock.

### 5.3 Make standing machine grants visible

The one case a prompt cannot serve is **a machine that reboots with nobody
there** — an overnight OS update with a 03:00 backup due. That case already has
its mechanism and it already ships: `MACHINE_ONLY_SECRET_PREFIX = '__machine__'`
(`secrets.ts:56`) puts one specific secret in the OS keychain instead of the
vault, and such secrets are excluded from `exportSecrets` and refused by
`importSecrets` (`secrets.ts:88`, `:103`) — which is exactly what holds the
trade together, because the secret then cannot leave in a bundle.

**Two of these already exist on users' machines** — a scheduled backup
passphrase, and addy's key material — **and no screen lists them.** A standing
authorisation that nothing enumerates cannot be withdrawn. That is the
`credProxy.ts:44` objection ("durability defeats revocation") applied to the
vault.

So: one Settings list of every live `__machine__` grant, with what it is for,
when it was granted, and a revoke.

## 6. What should stay blocked

**Fleet SSH keys and server passwords, in the general case.**

The `__machine__` trade works *only* because a granted secret does not travel in
a backup. But the documented reason SSH key material lives in the vault rather
than as a `keyPath` is precisely that it **must** travel with a backup
(`shared/vault.ts:63`, `docs/vault.md:30`). Granting fleet credentials
unattended either breaks restore, or requires holding the vault key itself at
`safeStorage` level — which is persistent-scope biometric unlock, which already
exists and is already documented as the weaker thing.

A user who wants everything unattended should meet that switch and its warning,
not a new mechanism that hides the same trade behind a friendlier word.

## 7. Defects found while mapping

### 7.1 A mistyped password locked a working vault — FIXED

`vaultUnlock`'s catch zeroed the key, salt and cache unconditionally, without
asking what the vault was doing beforehand. From `secured` — unlocked, serving
every background reader, renderer plaintext dropped — one typo stopped the
sampler, backups, CI polling and VPN autostart together. Fixed in `15b5dbeb`.

### 7.2 A corrupt vault file reports "No vault has been created yet"

`readFile()` swallows any parse error and returns null, while `existsSync` still
says the vault exists. **Open question:** can that state lead to the vault being
overwritten or a second one created? If so it is data loss and jumps the queue.

### 7.3 No failed-attempt counter and no lockout

Not necessarily wrong given §2 — the offline attacker has the file and can
brute-force it outside the app anyway, where a counter would not apply. But it
should be a decision rather than an absence.

### 7.4 Biometrics is macOS-only, and that is platform-shaped

`biometricSupport()` reports unavailable on Windows (Electron exposes no Hello
API and the code declines to ship an unverifiable native module into the path
guarding the credential store), and on Linux entirely. **So on Windows and Linux
every user is a password-only user**, and there is currently no answer at all to
"I want fleet credentials unattended after a reboot" beyond typing the password.

Worth noting that the *storage* half is already platform-neutral — `safeStorage`
is DPAPI on Windows and libsecret on Linux. Only the gate is macOS-only.

## 8. Open questions for the owner

1. **§7.2** — can a corrupt vault file be overwritten? Data loss if yes.
2. **§5.3** — is a Settings list of `__machine__` grants wanted now, or is
   noting the gap enough for this pass?
3. **§7.4** — should the existing persistent-key opt-in be made available on
   Windows and Linux without a biometric gate, keeping its current warning? It
   is the same trade already shipping on macOS, and it is the only answer those
   platforms have. This is a security decision, not an implementation one.
4. Is a `__machine__` grant ever re-checked against the vault entry it was
   copied from? **Answered: no, and not detectable.** `VaultEntry` carries no
   version, hash or `updatedAt`, so "has the vault copy changed since the
   grant" has nothing to compare against. Recording a hash at grant time would
   make it detectable; that is a decision, not a fix, and it is not taken here.
5. **Should the launch prompt also be raised after a suspend?** §5.1 argues
   not — a prompt lands on a screen the user is walking away from, and a laptop
   suspends several times a day. If backups sitting paused after a wake turns
   out to matter more than the nag, this is the line to change.

## 9. Provenance

Four parallel audits, 2026-09-20: the state machine, the surface inventory, the
threat model and unattended options, and the password-only path. Every claim
above carries a file:line in the source reports. Two claims in the first draft
of this document were corrected by those audits and are marked where they were.
