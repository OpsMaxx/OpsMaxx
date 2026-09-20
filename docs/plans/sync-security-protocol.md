# The sync security protocol, next to Termius's Vault

> **Status: analysis, 2026-09-21.** Written against Termius's Security
> Whitepaper 3.7 (January 2024), `termius.com/vault`, `termius.com/pricing`,
> `termius.com/security` and `sshid.io`. Parts 1–3 are a comparison and are
> stable. Part 4 is the defect list it produced; four of its six items shipped
> in the same branch as this file and are marked, and the two that did not say
> why.
>
> `docs/plans/addy.md` remains the design of record for the protocol itself.
> This file does not restate it — it reads it against somebody else's, which is
> a thing a design document cannot do for itself.

## Why this exists

We were asked whether our sync is doing something wrong, or missing something
the Termius Vault has. The honest answer needed three piles rather than one,
because a feature matrix mixes them together and a matrix is what makes a team
copy the wrong thing:

1. Where our protocol is **stronger** and nothing we publish says so.
2. Where it is **equivalent but differently shaped**, and copying Termius would
   be a downgrade.
3. Where we are **actually weaker**, at the protocol or the workflow level.

Only the third pile is work. The first is a writing problem and the second is a
decision that deserves to be recorded once so it is not relitigated.

One framing decision up front. Termius is a hosted, multi-tenant,
account-based product with a paid team tier. OpsMaxx has no account and no
vendor cloud, and addy is deliberately one person with many of their own
devices — `docs/plans/addy.md` has the non-goals. **That stance is kept.**
Nothing below proposes an account system, an SSO integration or a team vault.
Where Termius has one and we do not, that is the product, not a gap.

---

## 1. The two protocols

### 1.1 Termius, as the whitepaper describes it

**Genesis.** A random key pair per user. From it a personal encryption key,
which encrypts all vault data — hosts, groups, keys, identities, passwords,
known hosts, port forwards, snippets, packages (p.8). The **private key is
wrapped under the encryption password**, and the wrapped blob syncs. The
password never reaches the cloud (p.9).

**Authentication.** A modified **SRP6a** exchange. The server sends a salt for
an **Argon2id** hash and server randomness; the client returns its own
randomness and a proof; the server returns a server proof, an **encrypted API
token** and a salt. Both sides prove possession of a symmetric key derived from
the password hash without transmitting either (p.11). The session token is
cryptographically bound to the password.

**Password change.** A new Argon2id hash locally, the account private key
**re-wrapped** under it, other sessions invalidated (p.12). Note what does not
happen: the data encryption key is unchanged, so stored ciphertext is not
re-encrypted.

**Password reset.** Available by email verification, and it **destroys all
vault data** (p.4, p.9). There is no escrow.

**Shared vaults.** The owner generates a per-vault symmetric key and seals it to
each member's personal public key; a member decrypts with their own private key
plus the owner's public key, which authenticates the sender too (p.10).
Permissions are "can edit" or "can view", plus a third mode that shares
**obscured credentials** — connect with a key you may never read (p.12).

**Primitives.** libsodium with a custom C++ binding: X25519, XSalsa20-Poly1305,
Argon2id, SRP via Botan, gRPC (p.13). Keys at rest in iOS Keychain / Android
Keystore, "isolated from vault data" (p.12–13).

**Revocation.** Per account, vault, device and session; remote logout;
unpairing removes access; removing a user from a team removes the data from
that user's device (p.4). To revoke universally, change the encryption
password — which, per p.4, wipes the data.

**SSH.** FIDO2 `sk-` keys generated on a YubiKey, private half never exported
(p.15). Biometric keys in the device secure enclave (p.16). Terminal sharing
over WebRTC, end-to-end, owner-revocable (p.13–14).

**sshid.io** is a separate and much simpler idea: device-bound passkeys,
generated on-device, never exported, never synced. Only the **public** key
syncs, and an administrator pastes it into `~/.ssh/authorized_keys` by curl. No
CA, no daemon, no agent.

**What no tier advertises:** an audit log, session recording, SCIM, or a device
inventory. Free is local-vault only; cloud vault at Pro $10; one team vault at
Team $20; multiple vaults and granular ACL at Business $30; SAML SSO and the
SOC 2 report at Enterprise.

### 1.2 addy, as built

**Genesis.** A BIP39 12-word seed. HKDF-SHA256, fixed domain-separator salt
`addy-genesis-v1`, info `label ‖ 0x00 ‖ accountID ‖ BE(epoch)`, giving an
Ed25519 root signing key and an X25519 root encryption key
(`sidecar/addyd/protocol/keys.go`). The account id is
`SHA-256("addy-account-id-v1" ‖ 0x00 ‖ rootSignPub)` truncated to 16 bytes.

**Epoch keys.** `AK_n` is **32 random bytes, not derived** — which is exactly
what makes it rotatable. From it: an epoch signing seed, an epoch encryption
scalar, and `K_profile_n`, the one key that seals every collection in that
epoch.

**Object sealing.** XChaCha20-Poly1305, 24-byte random nonce, AAD binding
**account id ‖ epoch ‖ collection name** (`protocol/object.go`). The X variant
because a 12-byte nonce needs a per-key counter and two devices writing the
same collection under one `K_profile_n` cannot coordinate one. The AAD because
a hostile relay must not be able to answer a request for `servers` with the
`vault` ciphertext, or with last epoch's.

**Escrow.** HPKE — DHKEM-X25519, HKDF-SHA256, ChaCha20-Poly1305 — sealing
`AKSeed`, the roster head and a monotonic counter to the root encryption public
key, with a 32-byte exporter-derived commitment checked in constant time
*before* the AEAD.

**Enrolment.** SPAKE2 over an unauthenticated relay rendezvous, confirmed by a
7-emoji short authentication string compared out of band; 180-second timeout;
three wrong codes ends the session, enforced in the sidecar. Device signing and
encryption keys are two independent draws, with an explicit refusal to
birationally convert Ed25519 to X25519.

**Relay authentication.** Two layers. A challenge-response login where the
sidecar signs `nonce ‖ TLS-SPKI-pin ‖ timestamp`, then *every* request signed
over method ‖ percent-decoded path ‖ body hash. The SPKI pin is SHA-256 of the
relay's TLS SubjectPublicKeyInfo taken over a raw socket and fixed at
enrolment. The bearer token is never written to disk.

**Roster.** `prev_hash`-chained, signature-verified client-side against keys
pinned at mint time from the client and never from the server, plus a
per-device anti-rollback pin `(pinSeq, pinHead)` so a relay that withholds
entries cannot resurrect a revoked device.

**Sync.** Last-writer-wins per collection, the loser preserved as a named
conflict copy uploaded *before* anything is overwritten. ETag `if-match`
optimistic concurrency. A monotonic counter sealed *inside* the ciphertext
refuses rollback. A schema version, also inside, makes an older client go
**read-only rather than degraded**. Polling every five minutes.

**Revocation.** Epoch rotation that deliberately **does not chain**: `AK_{n+1}`
is sealed individually to each surviving device, so a revoked device holding
`AK_n` cannot derive it. On the revoked device a tombstone is written *before*
the wipe so an interrupted wipe resumes, and sessions are closed before files
are deleted.

**The vault crosses as opaque bytes.** `opsmaxx-vault.json` — already
AES-256-GCM under scrypt(master password) — is carried verbatim and re-sealed
under `K_profile_n`. Double-encrypted, and the sync layer has no path that
opens it.

---

## 2. Where we are stronger, and the documentation does not say so

Not code work. Writing work — a reader comparing the two papers today would
conclude the wrong thing.

**Revocation.** Termius's universal revocation is "change the encryption
password", which per p.4 destroys the data. Ours is a non-chaining epoch
rotation that re-seals a fresh `AK_{n+1}` to each surviving device and keeps
every byte. That is a strictly better primitive and nothing we publish mentions
it.

**Password change.** Termius re-wraps the account private key and leaves the
data ciphertext alone, so an attacker who later learns the *old* password
recovers the wrapped private key, hence the data key, hence current data. We
re-derive and rewrite the whole vault blob under a key from the new password,
so the old password opens only old ciphertext.

**Object substitution.** Our AAD binds account, epoch and collection name. The
Termius paper describes no AAD at any layer. State our property; do not
speculate about theirs.

**Relay trust.** Our relay holds no key, and the roster is verified against
keys the client pinned at mint time. Termius's cloud holds the wrapped private
key and the SRP verifier. Both are zero-knowledge in the marketing sense; ours
has less to lose.

**The three-stage vault lock.** `locked` / `secured` / `open`: the idle timer
moves to `secured`, not `locked`, so scheduled backups and monitoring keep
resolving credentials while the renderer's plaintext copy is dropped. Two
separate read paths enforce it — `vaultList()` for humans, which touches the
idle timer, and `vaultEntriesForResolve()` for background work, which does not.
Termius has one lock state.

**SSH agent.** We host one where every signature is gated by policy, default
ask, with `session-bind@openssh.com` support specifically so a *forwarded*
request re-prompts every time ahead of anything remembered. The Termius paper
claims nothing comparable.

**Audit.** A redacted, append-only, 0600, symlink-refusing record of everything
the AI bridge did. Termius shows no audit-log feature at any tier.

### 2.1 And the cost of the opaque blob, which is ours alone

Because the sync engine cannot read the vault, it also could not tell the vault
module it had replaced the file. `vault.ts` reads its file once, at unlock, and
serves the decrypted cache for the rest of the session, so a pulled vault sat
on disk unseen for a whole session — and the next save would have re-sealed the
stale cache and pushed it as the account's winner, destroying every other
device's credentials from one edit. Fixed by `vaultExternalChange()`, which
tries the held key against the arriving copy first (two devices sharing a
vault's lineage share its salt) and locks when it cannot open it.

Termius has no equivalent blind spot, because their sync layer knows the data
model. This is a real cost of our design, not a bug that merely happened. It
belongs next to the benefits, not hidden behind them.

---

## 3. Where copying Termius would be a downgrade

Recorded so it is not reopened.

**Not SRP6a.** SRP authenticates a *password* to a *server*. Our relay login
authenticates a device key over a TLS-SPKI-pinned channel and signs every
subsequent request. Adding a password-authenticated handshake would add a
phishable, brute-forceable secret to a protocol that has none.

**Not Argon2id for the vault.** We use scrypt N=32768 r=8 p=3, chosen against
OWASP guidance, with a recorded upgrade path and a guard test. Node has no
Argon2id without a native module — which is why the Bitwarden importer refuses
Argon2id accounts outright. Trading a working, tested, pure-Node KDF for a
native dependency buys nothing.

**Not a second password.** Termius needs an encryption password separate from
the login password because it has an account. We have no account: the master
password protects the vault, the BIP39 phrase is the addy account. A third
secret would be ceremony without a threat it answers.

---

## 4. Where we were actually weaker

### 4.1 The estate was plaintext on disk — FIXED

`opsmaxx-data.json` held every hostname, port, username, label, folder,
workspace, database, tunnel, VPN and CI connection in the clear. On the relay
the same data is sealed under `K_profile_n`; in a backup bundle it is
AES-256-GCM. Only on the local disk — where it spends all of its time — was it
unprotected. Termius encrypts its local cache (p.12).

The credentials were sealed and the target list was not, and the target list is
the reconnaissance half of an attack: which hosts exist, which accounts, which
ports, how they are grouped. Anything reading the filesystem as the user got
the complete map — malware with no keychain entitlement, a cloud-backed
Documents folder, a Time Machine snapshot, a support bundle, a borrowed laptop.

It is now sealed with the OS secure store, **not** with the master password,
and that is a workflow decision as much as a crypto one: the server list has to
render while the vault is locked, because seeing your servers is how you decide
to unlock. A password-derived key would invert that.

Three things fell out of doing it:

- The **third state**. Present-but-undecryptable — a restored copy of someone
  else's folder, or this folder after a keychain reset — must land on the same
  side as corrupt and never on the side of "this machine has nothing", because
  that answer is what sync uses to decide whether to write. A corrupt file once
  read as empty, so every collection was adopted from the relay and the blob
  rebuilt from `{}`, destroying `settings`, `tabs` and every key with no relay
  copy.
- The **backup file**. `saveData` copies the live file to `.bak` before each
  write, so sealing only the primary would have left the last readable copy of
  the whole estate beside it under a name that says it is a backup. Worse, that
  file was **missing from the wipe list** — "delete all data" removed the
  server list and left the server list behind. The guard test that exists to
  catch this greps for the literal `getPath('userData'), '<name>'` form and
  could not see a name built as `${FILE}.bak`.
- **Plaintext is still written on a machine with no OS keyring.** `secrets.ts`
  refuses to persist in that case, which is right for a credential; it is the
  wrong trade for the application's entire state, which would brick a
  keyring-less Linux box in the name of protecting it. The rule kept is not
  "never plaintext" — that was never true of this file — but that nobody gets
  plaintext while believing otherwise. The diagnostics payload carries
  `dataFile.sealed`.

### 4.2 The audit log — PARTLY FIXED

Two defects, one file.

**Silent failure — fixed.** `appendLogLine` refuses a symlink at the audit path
and a file owned by another uid. Both refusals are right and both were
invisible: an install in either state wrote zero rows while `listAudit` kept
returning the rows from before, so the view did not look broken, it looked
quiet. The main-process half already remembered why; nothing read it. It is now
surfaced above the list, and above the empty state — because "No AI activity
recorded yet" is a claim about the servers and the true one is about the file.

**Not tamper-evident — fixed.** `opsmaxx-ai-audit.jsonl` is plain 0600
JSONL; anyone running as the user can rewrite or truncate it undetected. The
right primitive is already in the repo: the addy roster is `prev_hash`-chained
and signature-verified. The protocol detail that matters is that a hash chain
detects **rewriting** but not **truncation** — a truncated chain is still
internally valid — so it needs a head pin `(seq, hash)` somewhere the log's own
writer cannot quietly edit, which means the OS secure store, alongside the
device keys. That is the identical construction to addy's `(pinSeq, pinHead)`
anti-rollback pin, against the identical attack.

Shipped as: every row carries its predecessor's hash and a hash of itself, and
the head `(seq, hash, floorSeq)` is pinned in the OS secure store. The
predecessor hash is carried *in the row* rather than only recomputed from the
neighbour while walking, because the oldest row still present has no surviving
neighbour — retention removed it — and a check that skips the first row is a
check that invites every edit to be made there. `floorSeq` exists because
retention legitimately removes rows from the front, and without it a prune and a
front-truncation are the same event; the retention sweep is the only thing that
moves it.

Two states that must not read as tampering, and do not: an install whose rows
predate the chain reports `unknown` rather than `broken`, and a log with old
unchained rows underneath new chained ones verifies, reporting how many rows it
did not vouch for.

The ceiling, stated in SECURITY.md rather than implied: the pin is in the
user's own keychain and anything running as the user can reach it. This is
tamper-evident, not tamper-proof. What it buys is that rewriting history stops
being "edit a text file" and becomes "edit a text file, recompute a chain, and
rewrite a keychain entry". Proof would mean shipping the rows off the machine,
which is a different feature with a different threat model.

### 4.3 Hardware-backed keys — FIXED

`sk-ssh-ed25519@openssh.com` and its ECDSA sibling appeared only in the
*remote* `authorized_keys` auditor. It read other people's hardware keys and
could not use one.

It was worse than a missing feature. `DEFAULT_IDENTITIES` lists `id_ecdsa_sk`
and `id_ed25519_sk`, so a user with a hardware key and no explicit
`IdentityFile` had one picked **by us**, read off disk and handed to ssh2 as
`privateKey` — which it is not. An `sk-` file holds a credential handle and an
application string; the private half is on the authenticator and a signature is
a CTAP2 assertion and a touch. The connection failed with "All configured
authentication methods failed", the same message a wrong username gives.

The fix routes such a key to the system agent, which already does this properly
on macOS and Linux including the touch prompt, rather than linking libfido2.
The type is read from the file, not the filename: OpenSSH's v1 container keeps
the public key in the clear even when the private half is encrypted, so the
answer arrives without a passphrase prompt — which matters, because that prompt
is exactly what we are trying not to raise for a key no passphrase would help
with. Our own agent still refuses smartcard opcodes; that is OpsMaxx as a
server, this is OpsMaxx as a client.

**sshid.io is deliberately not matched.** Device-bound passkey, public half
published, administrator pastes it into `authorized_keys`. It needs a hosted
page to publish to. We do not have one and are not building one.

### 4.4 Sync granularity was whole-collection — fixed, by a different route

Last-writer-wins per collection, the loser kept as a conflict copy. The sync
unit is the whole `servers` array, so adding a host on the laptop while
deleting one on the phone inside the same five-minute window is not a merge, it
is a conflict a human must open the chooser and resolve. For one person with
three devices and a large fleet that is routine friction Termius does not have.

**Why per-item tombstones are the blocker.** Deletes propagate by absence: the
array is written without the entry. Merging item-wise without tombstones would
resurrect every delete, which is precisely why blob-LWW was chosen. The only
tombstone in the repo is the device-revocation record, not a sync marker.

**The design that was planned, and why it was not built.** The obvious shape is
`{id, updatedAt, deletedAt}` per record inside the sealed payload, merged
item-wise. It costs a schema bump, which puts every device on an older build
into read-only by `ErrSchemaTooNew` until it updates, and it needs tombstones,
because a delete is expressed by absence and an item-wise merge without them
resurrects every one. The byte-equality note in `serversSource` made it look
worse still.

**What was built instead: a three-way merge.** None of that is necessary if the
common ancestor is available, and it is — the last state this device agreed
with the relay about. With an ancestor, "absent here and present there" stops
being ambiguous: it is a delete if the ancestor had it and an add if it did not.
That is an ordinary three-way merge, and **the payload on the wire does not
change at all**. No schema bump, no tombstones, no read-only period, no
migration; a device on an older build reads a merged collection exactly as it
reads any other.

The ancestor is kept as a fingerprint per id, not as the records. It answers
both questions the merge asks — was this record present, and has it changed —
and nothing else, so `opsmaxx-addy-sync.json` does not become a second
plaintext copy of the estate sitting beside the sealed one. Ids are generated
and opaque; no hostname, username or label is in it.

**What it refuses to decide**, all of which still go to the conflict copy and
the chooser, unchanged: a record both devices changed differently, a record
edited on one side and deleted on the other, a payload that is not a list of
identified records (`apiWorkspace` is an object), duplicate ids, and a
collection with no recorded ancestor. The aim was to stop asking a person about
edits that do not overlap, not to start guessing about edits that do.

Two smaller things fell out. Identical payloads on both sides are two devices
agreeing, not a merge — they short-circuit to `unchanged` rather than burning a
revision to record that nothing happened. And `merged` had to join `pulled`,
`adopted` and `conflicted` in the list of outcomes the renderer is told about:
a merge writes to disk, and a renderer that is not told goes on holding the
pre-merge copy and saves it back over the top.

### 4.5 Two smaller inconsistencies — one FIXED, one a workflow note

**The workspace verifier was the last scrypt at p=1 — fixed.** The vault and
backups were raised to p=3; this was left behind with no note saying whether
that was a decision. It gates the UI and encrypts nothing, so cracking it wins
an attacker nothing they did not already have from the estate — but what a
cheap verifier leaks is the *password*, and people reuse them. Raising the
constant alone would have been a lockout rather than a hardening, because the
file recorded no parameters: every stored verifier would have stopped matching,
indistinguishably from a wrong password. It now records them and re-derives on
the next correct entry, which is the arrangement the vault already had.

**Revocation needs the one secret with no second factor — unchanged.** Epoch
rotation requires the BIP39 phrase, and `docs/plans/addy.md` says it plainly:
"It is the one thing in this system with no second factor." The emergency
operation depends on the artefact least likely to be at hand in an emergency.
No code fix is proposed. The fix is that the recovery-phrase workflow should
say when you will need it, at the point it is first shown.

---

## 5. A note on DocGov

`.claude/rules/documentation.md` requires new documentation to be created
through `docgov create`, and its class checked with `docgov whatis`. **The
`docgov` CLI is not installed in this worktree** — not on `PATH`, absent from
`node_modules/.bin` and from `package.json`, and the package name 404s on the
registry. `.docgov/` holds the output of a past run, in which all 29 registered
documents are typed `unknown`.

So this file follows the existing convention instead: `docs/plans/`, where
`addy.md`, `addy-client.md` and `vault-ux.md` already live. That satisfies the
rule's actual prohibitions — no new top-level file, no new documentation
directory — and the step that could not be run is recorded here rather than
skipped quietly.
