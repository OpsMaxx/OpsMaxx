# addy — an E2EE satellite relay for OpsMaxx

## Context

OpsMaxx today is a single-machine desktop app. Everything it knows about you —
servers, workspaces, vault entries, VPN profiles, tunnels, terminal preferences —
lives in `<userData>/opsmaxx-*.json` on exactly one computer. The only path off
that machine is `src/main/services/backup.ts`: a passphrase-encrypted `.spbackup`
bundle you write to a local dir, SFTP or S3 by hand. There is no `deviceId`, no
sync, no relay, no remote reconciliation anywhere in `src/` (confirmed by search).

That makes OpsMaxx a victim of the exact problem its users complain about: the
operator's identity, environment and working state belong to a physical machine
instead of to the operator. A new laptop means rebuilding 47 undocumented
configuration decisions by hand. A second laptop means the SSH key, the
kubeconfig, the `.env` and the WireGuard profile are each on precisely one of
them. The workarounds people reach for — Slack-to-self, Telegram saved messages,
a screenshot of a QR code, a token pasted into Notes — are all *worse* for
security than the problem they solve. Poor multi-device UX actively manufactures
credential sprawl.

**addy** is a small self-hosted server that fixes this without ever being trusted
with the secrets. It is a relay, a signalling server, a quota-metered blob store
and a service-deployment helper. OpsMaxx is its client. The load-bearing
constraint, which decides nearly every design choice below, is:

> Someone who owns your addy box completely — root, database, object storage, the
> binary it serves — learns how many devices you have, each one's IP address and
> when it is online, the size and change history of every encrypted collection,
> which of your devices talk to each other and when, and your plaintext
> preferences. They do not learn the contents of your servers, vault entries, VPN
> profiles, tunnels, `.env` files or transferred files, and they cannot forge a
> roster entry, so they cannot mint a device of their own.
>
> They can still do four things, and you should treat all four as real. They can
> serve you old data or destroy it — your devices hold the plaintext, so that is a
> recovery problem rather than a disclosure one, but a device restoring from
> scratch cannot tell an old copy from a current one except by comparing the
> roster hash against a device you still have. They can serve you a modified web
> portal: **never type your recovery phrase anywhere but the OpsMaxx desktop app,
> and compare a roster hash between two OpsMaxx windows, never in a browser.**
> They can read every credential for any service addy deployed for you — the
> Vaultwarden admin token, the headscale keys, the WireGuard server key, the frp
> token — because that is what deploying a service means. And they can crack any
> `.spbackup` you stored on them, at the strength of the passphrase you chose.
>
> Your recovery phrase is the whole account. Anyone holding it can read everything
> and add a device, with or without addy. It is the one thing in this system with
> no second factor.

That is the product, and it is deliberately not the sentence this plan started
with. The first draft claimed "they do not learn one credential" full stop; an
adversarial review broke it in four independent ways before a line of code
existed. The wording above is what survives, and the design below is what makes
it true — including the two mitigations that turn the `.spbackup` and
old-data clauses from open holes into stated, bounded costs.

**The boundary the claim depends on.** A box that only relays is the box that
paragraph describes. **Turning on service deployment changes it** — see the
services section — so the two are separable by design, and `THREAT_MODEL.md`
states them as two different products.

---

## Decisions taken (confirmed with the user)

| Decision | Choice | Why |
|---|---|---|
| Language | **Go** | pion is the most mature WebRTC stack in any language, and the repo *already ships Go* — `sidecar/netd/` is 12k LOC of it, cross-compiled to six targets by a script that already exists. |
| Install | **Compose first, Helm later** | One `curl \| sh` onto a fresh VPS covers ~95% of self-hosters. Same binary either way. **Contabo / DigitalOcean one-click is not in any milestone** — DO Marketplace is an external submission with its own review lead time, so it is a launch task to start early and cannot be scheduled as engineering work. The `curl \| sh` is what makes the promise real in the meantime. |
| Blob storage | **S3-compatible object store from day one — Garage** | User's call. The choice between Garage and MinIO resolved itself: MinIO CE was archived in April 2026. Behind one Go interface so the store stays swappable. |
| Scope | **All four areas are in scope** | Sequenced into milestones below, not dropped. |
| Libraries | **Prefer existing OSS** | circl, coturn, pion, age, certmagic. Written from scratch only where nothing exists. |

**One honest note on size, stated once.** This is a product, not a feature.
After a review pass corrected the original sizing: **M0–M3 — the spine, sync and
client integration — is four to five months on its own**, with continuity,
service wizards and hot-device provisioning after that. The milestone table
sequences them so each ships something usable alone, and so the
security-critical parts land first and get the most scrutiny. Nothing below is
speculative scaffolding; if a milestone gets cut, it gets cut whole rather than
half-built.

---

## The trust model

Three tiers. Which tier a piece of data is in is the single most important
decision in the system, so it is **data, in one file, pinned by a test** — not a
convention people remember.

### T0 — SECRET. Server sees ciphertext and a length.

The vault file (already ciphertext, re-sealed — see below), SSH key material, API
tokens, server/database/VPN/tunnel records, `.env` contents, clipboard,
transferred files, device labels, the hot-device manifest. Encrypted on the
client under a key the server has never held and cannot derive.

### T1 — METADATA. Server sees it because it cannot function otherwise.

Device **public keys** (needed to authenticate a login, so unavoidably in the
clear), the roster chain's shape and signatures, object names and sizes,
modification times, quota usage, connection timing, source IPs. Minimised, never
exported, never aggregated. This is the honest cost of using a relay at all, and
the threat model says so out loud rather than pretending otherwise.

Note what is **not** in T1: the device's *name*. See "Device identity is a
pseudonym" below — the label is ciphertext, so what the server holds for a device
is a random public key and nothing else.

### T2 — PUBLIC PROFILE. Plaintext on the server, deliberately.

`theme`, `terminalFontSize`, `terminalScheme`, `terminalCustomSchemes`,
`compactDensity`, `dbSchemaWidth`, `dbEditorHeight`, `cicdStepsWidth`,
`cicdDetailHeight`, `showMonitorStrip`, `closeTabOnShellExit`,
`switchHiddenWorkspaces`.

**`modules` was on this list and has been moved to T0 by security review.** It is
a capability switch, not a preference: a hostile server serving a plaintext
profile could enable `keyRevoke`, `broadcast`, `jobs`, `patch`, `rules` and
`cicdTrigger` — the entire `operate` surface — on every device in the account.
`backfillModules` (`src/shared/modules.ts:663`) exists precisely so that an
*upgrade* is not consent; letting a plaintext profile do what an upgrade may not
would invert that rule.

Two consequences for what T2 is allowed to contain:

- **T2 holds scalars and enums only**, each validated for range and shape on
  arrival, reusing the existing parsers (`parseTerminalScheme`) rather than
  trusting the wire. A plaintext profile from a hostile server is untrusted
  input, and it feeds a client-side parser.
- **No key whose *absence* grants something may be in T2.** `AppSettings` merges
  saved-over-default, so several keys read absence as "on" —
  `localTerminalEnabled` is the sharp one. Against that polarity an *omission*
  is an attack, so `tests/addyTrustBoundary.test.ts` asserts not just "every key
  is classified" but "no capability-gating key is in T2", and pins the polarity
  trap by name.

That list is not invented, but it also does not come from one place, and getting
this wrong would undermine the guardrail below. Precisely: **eleven of the
thirteen are the cosmetic subset of `AppSettings`**
(`src/renderer/src/store/app.ts:101`); `theme` is not among them because it
"lives on AppState rather than in `settings`"
(`src/renderer/src/store/persist.ts:14-27`); and `modules` is a `ModuleState`
(`src/shared/modules.ts:639`), not an `AppSettings` key at all. The T2 profile is
plaintext so a brand-new device can pull a usable-looking OpsMaxx before any
pairing has happened.

**Who may read T2 must be specified, not assumed.** An earlier draft said a user
gets their layout back "from their password alone" — there is no account password
in the key hierarchy, so that sentence described nothing. The choice is explicit:
T2 is readable by **an authenticated device of that account only**, never
world-readable. A world-readable profile would leak the estate's technology
profile (which modules, which terminal tooling) to anyone who guesses an account
id, and inventing a password to protect it would add an unanalysed server-side
brute-force target to a design that deliberately has none.

**The guardrail, pointed at two different things.** A new key is T0 unless it is
explicitly added to the T2 allowlist in a new `src/shared/addyProfile.ts`.
`tests/addyTrustBoundary.test.ts` asserts that allowlist against **three** key
sets, not one — `AppSettings`, the `ModuleId` union, and the AppState fields the
profile claims — because a test that only knew about `AppSettings` would silently
fail to cover `theme` and `modules`, which are two of the thirteen entries. A
guardrail with a hole in it is worse than none, because it is believed.

That catches a new setting and misses a new **record type**, which is the more
expensive mistake. A second assertion in the same test pins the collection list
against `Persisted`'s key set (`src/renderer/src/store/persist.ts:10-55`): every
key is either in a synced collection or in an explicit `NOT_SYNCED` list with a
written reason. Without it, the next feature that adds a `cicdConnections`-shaped
record simply does not sync, and **absence is indistinguishable from "I haven't
added one yet"** — a silent failure with no error and no symptom until someone
notices their database connections never made it to the second laptop.

This copies the mechanism that already works twice in this repo:
`backfillModules` (`src/shared/modules.ts:663`, absent reads as OFF) and
`tests/backup.test.ts` pinning `ALL_DATA_FILES` against a directory listing.
Default-deny, enforced by CI, is the only version of this that survives contact
with a year of feature work.

---

## Key hierarchy

**Revised after security review.** The first draft derived one account key from
the mnemonic and sealed *that* to every device. That makes revocation
non-cryptographic: a revoked or stolen laptop still holds the account signing key,
so it can author a valid roster entry re-admitting itself — and every honest
client verifies the signature and accepts it. It also keeps decrypting every
collection written *after* its revocation. A stolen laptop would have been a
permanent, unrevocable account compromise, and `safeStorage` is readable by
anything running as the user (`SECURITY.md:260`), so "stolen laptop" means
"stolen account key". The fix is an epoch.

```
BIP39 12 words (128 bits)          ← the ONLY thing a user must keep
  │                                   never transmitted, never on the server
  └─ HKDF-SHA256 ─┬─ RK_sign  Ed25519   ROOT. Authorises epoch changes only.
                  └─ RK_enc   X25519    opens the escrow blob

Account epoch key AK_n — random, ROTATABLE, this is what devices hold:
     AK_n.sign   Ed25519   signs roster entries within epoch n
     AK_n.enc    X25519    HPKE recipient
     K_profile_n           seals every T0 collection in epoch n

Per device, generated locally, never leaves:
     DK_sign  Ed25519   device identity; authenticates to the server
     DK_enc   X25519    HPKE recipient; receives AK_n during pairing
```

The epoch chain is its own tiny signed log: `{epoch, AK_n.pub, prev_epoch_hash}`,
**signed by `RK_sign`**, whose public half is fixed in the genesis entry. A device
holds `AK_n` and never `RK`.

### Two kinds of revocation, because they are two different events

| | **Soft revoke** | **Hard revoke / re-key** |
|---|---|---|
| Signed by | `AK_n.sign` — any paired device | `RK_sign` — needs the mnemonic |
| Does | Removes the device from the roster; honest devices stop encrypting to it; the server stops serving it | Mints `AK_{n+1}`, re-seals every collection, re-seals to each surviving device |
| Good for | "I sold my old laptop" | "My laptop was stolen"; compromise mode |
| Does **not** | Stop a malicious holder of `AK_n` re-admitting itself | — |

The UI states that difference in words at the button, because a soft revoke that
a user believes is a hard one is worse than no revoke at all. Anything phrased as
theft, loss or compromise routes to the hard path and asks for the phrase —
which is precisely the rare, high-stakes moment the printed card exists for.

What re-keying still cannot undo: anything the attacker already fetched and
decrypted before revocation. Rotation protects the future, never the past, and
the threat model says so rather than implying otherwise.

Device private keys are sealed with Electron `safeStorage` into
`opsmaxx-secrets.json`, the same store that already holds the traffic inspector's
CA key (`SECURITY.md:54`).

Note what is *not* in this hierarchy: the vault master key. addy sync does **not**
reuse `vaultExportKey()` (`src/main/services/vault.ts:200`) — see the vault
section below.

The server stores public halves only.

---

## Device identity is a pseudonym, generated at runtime

A device's identity **is** its freshly generated `DK_sign` public key. Nothing is
read from the host to produce it: no hostname, no OS username, no MAC address, no
disk or board serial, no `machine-id`, no platform advertising identifier. The
keypair comes from the CSPRNG at first pairing and that is the whole of it.

The friendly name a human sees is likewise **generated**, not observed — and it
is generated to be *memorable*, because a name nobody can hold in their head is
just a machine id with extra steps, and the whole point is that a person has to
recognise their own device in a revoke dialog under stress.

The shape is Heroku-style: `adjective-noun-NN`, e.g. `quiet-otter-41`,
`brave-pylon-07`. Two existing libraries do exactly this and either is a fine
starting point — `unique-names-generator`
(github.com/andreasonny83/unique-names-generator, TypeScript, curated
dictionaries, configurable separator and seed) and `haikunator`
(github.com/usmanbashir/haikunator, the Heroku-name pattern with a numeric
token). The client side is TypeScript so `unique-names-generator` is the
natural fit; the server needs the same grammar in Go for its own display, so the
**wordlists are vendored once and shared**, and a test pins them identical
across the two implementations — a device that is `quiet-otter-41` in the app and
something else in the portal is worse than no name at all.

The user may rename it locally, and if they rename it to something identifying
that is their business, which is exactly why the label is encrypted rather than
sent in the clear.

This is already the house pattern: the existing per-install id is
`sp-<randomUUID()>` (`src/main/index.ts:2610-2631`) — random, never host-derived.
addy follows it and goes further in one respect: **that id is not reused here.**
It is deliberately excluded from wipe (`backup.ts:~345`) and is used to claim
ownership of detached remote jobs, so reusing it as the addy device identity would
correlate a person's relay identity with their job records on every server in the
estate. A fresh key per device, and re-pairing after a revocation mints a new one
rather than resurrecting the old.

Consequences worth stating: two devices belonging to the same person are
indistinguishable to the server except by their key and their traffic; a device
that is wiped and re-paired is a new device to everyone; and there is no value
anywhere in the system that a host compromise could correlate back to hardware.

`tests/addyIdentity.test.ts` pins this — the device-id generator must not import
`os`, and must produce different ids for two calls with the same environment.

## The roster: why a hacked addy still cannot add a device

This is the control that makes the headline claim true, so it gets its own
section.

The device list is an **append-only hash-chained log**, not a database table.

```
entry := { seq, prev_hash, op: "add"|"revoke", pub_sign, pub_enc, label_ct, ts }
signed by AK_sign
```

`label_ct` is the pseudonym sealed to `K_profile_n`. The signature covers the
ciphertext, so the server can verify nothing and read nothing while still serving
the chain faithfully — it does not need to understand an entry to store it.

### The rollback hole on recovery, and how it is closed

The `seq` pin protects a client that already has state. A device restored from
the mnemonic alone has none — so a malicious server can serve it a **truncated
chain**, one from before a revocation, and the restored device will happily
re-seal the new epoch key to a device the user revoked months ago. The original
adversary-test list tested rollback against a client that already had a pin,
which is the case that already worked.

Closing it takes two things, neither optional:

1. **Recovery ends in a mandatory device review.** After a mnemonic restore the
   user is shown every device in the roster and must confirm the set before any
   collection is re-sealed. It is the one moment where a human is guaranteed to
   be present and paying attention.
2. **The printed card carries the roster head hash and device count at print
   time**, so a user who kept it has an out-of-band anchor for that review.
3. **The escrow blob carries the signed roster head and its own monotonic
   counter**, so serving an old escrow is detectable rather than invisible.
4. **Recovery forces a hard re-key before anything syncs** — a fresh epoch and a
   revoke-all, on the reasoning that a recovery is by definition a moment when
   the user no longer knows which devices are theirs.

### Two rules that follow from the portal being attacker software

A compromised addy serves the `--ui` portal, and that portal is same-origin with
the paste service and the T2 profile. It can render anything — including a
convincing "verify your recovery phrase" prompt, which would yield `RK`, every
T0 collection **and** the ability to author roster entries. It can equally
display a fabricated roster head hash, defeating the anti-fork control by being
the thing that reports it.

So, two rules, both absolute:

- **The recovery phrase is entered in the desktop app and nowhere else.** No
  browser, ever, on any page, for any reason. The portal has no field for it and
  the docs say a page asking for it is by definition an attack.
- **The roster head hash is compared between two OpsMaxx windows**, never read
  from the portal and never from `addy status` — both are software the attacker
  controls. An integrity check reported by the thing being checked is not a
  check.

**And it is compared as words, not as hex.** Bitwarden's "fingerprint phrase" is
the right idea: five words from the EFF long wordlist standing in for a key, so
two humans can actually check they match. Asking someone to compare 64 hex
characters across two screens guarantees they check the first four and the last
four, which is most of the way to not checking at all. We derive a five-word
phrase from the roster head and show that. The derivation is **ours** — Bitwarden
documents that theirs is five EFF words but deliberately does not publish the
function that selects them, so there is nothing to copy and no reason to try.
Same vendored wordlist discipline as the device names: one list, shared by the TS
and Go sides, pinned identical by a test.

The portal also ships **no service worker**, because one would survive both
`panic` and `reset --hard` and quietly outlive the remediation that was supposed
to remove it.

And `internal/roster/adversary_test.go` gains the two cases that actually
matter — a **revoked device signing a new entry** (must be refused once the
epoch has advanced) and a **truncated chain served to a client with no pin**.

Every client verifies the entire chain from genesis before it will encrypt
anything to any device in it. The server holds the chain but has no `AK_sign`, so
it cannot author an entry. A malicious server's remaining moves and their
answers:

| Attack | Defence |
|---|---|
| Insert an attacker device | Impossible for **the server** — it holds no signing key. Not impossible for a device that was once paired; that is what the epoch and hard revoke are for. |
| Replay an old chain (hide a revocation) | Each client pins the highest `seq` it has seen and refuses to go backwards — **but a client restored from the mnemonic alone has no pin**, which is the one case where this defence is absent. See below. |
| Fork the chain per device | `prev_hash` chain + the roster head hash is shown in the UI and in `addy status` for out-of-band comparison. |
| Withhold updates entirely | Detectable as staleness; every roster change raises a UI notification naming the device. |
| Serve a wrong `pub_enc` for a real device | Signed in the entry; a mismatch fails verification. |

A device is added by an **existing device**, never by the server.

**With one exception, stated because it would otherwise be a false claim:** a
device restored from the mnemonic alone holds `AK_sign` and therefore authors its
own roster entry, with no SAS and no second human — that is the entire point of
recovery, and the alternative is a user with a valid mnemonic locked out forever.
So the guarantee is precisely: *the server cannot add a device; only the account
key can, whether it is held by a paired device or reconstructed from the
mnemonic.* A mnemonic-authored entry is flagged as such in the chain and raises a
loud, separate notification on every other device — "a device was added using the
recovery phrase" is exactly the sentence a user needs to see if it was not them.

---

## Pairing: the fun part, done properly

A low-entropy human code must not be brute-forceable by the relay that carries
it. That rules out "type this token into a box" and rules in a PAKE.

1. Existing device generates a short code and shows it: `42-inkwell-flatfoot`.
2. New device types it.
3. Both run **SPAKE2** over addy's own `/v1/signal` WebSocket. The server carries
   the messages and learns nothing from them; a wrong guess costs an attempt, and
   attempts are rate-limited and burn the code.
4. Both display **7 emoji** in the Matrix SAS format, derived by HKDF from the
   PAKE transcript. The human confirms they match. This is the out-of-band check,
   and it is what defeats a server that tries to sit in the middle.
5. On confirm, the existing device HPKE-seals `AK` to the new device's `DK_enc`
   and appends a signed roster entry.

**Relabelled after review: SPAKE2 is the MITM defence; the emoji are a
tripwire.** The first draft credited the emoji with defeating a malicious relay.
They do not — SPAKE2 already does, and a *completed* PAKE cannot produce
mismatched SAS. Matrix's construction exists for unauthenticated DH, which this
is not. Both stay, because the emoji catch an implementation error or a
downgrade that the PAKE alone would not surface, but the labelling matters: it
decides what the adversary test is testing. Case 5 becomes "an injected
transcript fault produces mismatched SAS ⇒ abort **before** `AK_n` is sealed",
which is testable; "a PAKE peer that fails SAS" was not.

Two more corrections, both places where the security of a step had quietly been
handed to the attacker:

- **The attempt limiter runs on the initiating device, not the server.**
  `42-inkwell-flatfoot` is about 22 bits; SPAKE2 grants one guess per run, which
  is only a defence if somebody trustworthy counts the runs. Letting the relay
  count them hands the attacker its own rate limit. This is also a regression
  from code that already got it right — `cliPairing.ts:78-93` counts in the
  device's own main process. The adversary test runs **with the server's limiter
  disabled**, because that is the real condition.
- **The SAS is displayed only after the SPAKE2 key-confirmation MACs verify**,
  and the mismatch path is default-focused. Seven emoji beside one green Confirm
  button is not a control, it is a formality.

> **Correction to an earlier assumption: no magic-wormhole.** The obvious move
> was `wormhole-william`, but its `rendezvous` package is a *client only* — the
> reference mailbox server is Python, and the Go ports are abandoned hobby forks.
> Embedding magic-wormhole would mean either shipping a Python sidecar or
> reimplementing the nameplate/mailbox/phase protocol, and **neither is needed**:
> addy already owns a WebSocket between the two devices. SPAKE2 is a two-message
> exchange; carrying it over `/v1/signal` is ~100 lines against
> `salsa.debian.org/vasudev/gospake2` (the same library wormhole-william itself
> uses). Frozen upstream, but SPAKE2 is a finished spec, not a moving target.
>
> SAS derivation follows Matrix exactly (`sas-emoji.json`, 64 entries, indices
> 0-63): HKDF-SHA256 with **no salt**, IKM = the shared secret, then **6 bytes →
> the first 42 bits → 7 groups of 6 → 7 emoji**. Copied rather than invented,
> because a homegrown SAS encoding is a bug waiting to bias the output.

The existing `src/main/services/cliPairing.ts:52` device-code flow (6 digits,
60 s TTL, 5 attempts, code shown only inside the app window) is the UX precedent
to match — same shape, upgraded crypto, because that flow only ever had to resist
a local attacker and this one has to resist the relay.

**Recovery without any surviving device:** the mnemonic reconstructs `AK`, which
decrypts an escrowed blob on the server holding the roster and the collection
keys. This is the only path that survives losing every device at once, which is
precisely the scenario the product exists for.

Five decisions about that phrase, each of which is a real failure mode otherwise:

- **12 words, not 24.** 24 words is 256 bits of entropy feeding X25519 and
  ChaCha20-Poly1305, which top out at 128-bit security. The extra twelve words
  buy nothing and cost transcription errors and abandonment.
- **A printable card, not a file.** Setup opens the print dialog; it does not
  write a `.txt` into `~/Downloads`. Leaving the keys to the estate as a
  plaintext file in a downloads folder is the product's own "sensitive file
  residue" ick, committed by the product itself on day one.
- **Verification gates the *second device*, not first launch.** Nobody writes
  down a phrase while evaluating software they have used for ninety seconds.
  Gating first launch trains people to screenshot it; gating the moment they
  commit — pairing a second machine — is when they will actually go and find a
  pen.
- **A second door.** `AK` is additionally sealed to one optional recovery
  recipient: another age key, a hardware token, or a passkey. Roughly a day's
  work, and it converts "lost the paper, lost everything" into two independent
  losses. Without it there is exactly one door and it is made of paper.
- **Any surviving device can re-key.** Lost the card but still hold a working
  laptop? Today that is terminal, which is absurd. A surviving device rotates
  `AK`, re-seals every collection, appends the roster entries and issues a fresh
  phrase.

BIP39's checksum only ever says "this is wrong", never "word 17 is wrong", so
entry gets wordlist autocomplete and per-word validation. No 25th-word
passphrase — a second secret protecting the backup of the first secret is how
people lock themselves out.

### Genesis: how the *first* device and the account come to exist

Every flow above starts from "an existing device", which leaves the first one
undefined. It is defined here because the answer decides whether account identity
is server-asserted or client-asserted — and only one of those supports the
headline claim.

**Identity is client-asserted.** The first device, entirely offline:

1. generates the mnemonic and derives `AK`;
2. generates its own `DK_sign` / `DK_enc`;
3. authors roster entry `seq=0` (`op: "add"`, itself), signed by `AK_sign`;
4. builds the escrow blob and seals it to `AK`;
5. *then* registers with the server, presenting `AK_sign`'s public half, the
   genesis entry and the escrow blob.

The server **validates nothing about who you are** — it stores a public key it
has never seen before and cannot vouch for. That is the point. An admin does not
create an identity; an admin issues an **invite token that grants a quota slot**,
and the token is spent by an account the user minted themselves. A stolen invite
costs the admin disk space, not a user's data, because the thief cannot author
entries into anyone else's roster.

`addy` therefore has no password reset, no email verification and no account
recovery, because it has no account in the usual sense — it has a signing key it
was handed once. The mnemonic ceremony at step 1 is not a nicety; it is the only
backup that exists, and the UI must treat it accordingly (verify-before-continue,
not a dismissible toast).

The card and `THREAT_MODEL.md` both say what the phrase actually is, in these
terms: **a bearer token for the whole estate minus the vault** — unhardened,
un-rate-limited, and usable by anyone holding it from anywhere. Calling it a
"recovery phrase" invites the mental model of an account-recovery email, which is
the wrong one and leads people to store it accordingly.

### The vault crosses devices as ciphertext it never opens

The vault is the highest-value collection and the only one that already has its
own independent key, so it gets its own rule: **addy syncs
`opsmaxx-vault.json` verbatim, as opaque bytes, inside the `K_profile`
envelope.** Double-wrapped — the vault's own AES-256-GCM under the master
password, then sealed again for transport.

Three problems fall out at once:

- **Sync works in every lock state.** `locked`, `secured` and `open`
  (`src/main/services/vault.ts`, `SECURITY.md:55`) all become irrelevant,
  because nothing in the sync path ever needs to read inside the file. A sync
  loop that silently stalls for the 15-minute idle timer, or that pushes a stale
  copy because it could not read the local one, are both designed out rather
  than handled.
- **The mnemonic is not a skeleton key.** It reconstructs everything *except*
  vault contents, which still need the master password the user already knows.
  Without this the 24 words would be strictly more powerful than a master
  password that has a length floor, a tuned scrypt work factor
  (`vault.ts:39`), an auto-secure timer and an optional biometric gate —
  a silent downgrade of the strongest control in the product.
- **It is already the house decision.** The existing backup bundle stores the
  vault as "verbatim ciphertext" for exactly these reasons
  (`src/shared/backup.ts:2-17`). addy copies it rather than inventing a second
  policy for the same bytes.

On a clean device the restore order is therefore: mnemonic → `AK` → everything
non-vault comes back and the app is usable → the vault appears **locked**, and
the master password opens it. Two secrets, each doing the job it was designed
for, and no third one invented.

> `ponytail:` LWW on the whole vault file is coarse — two devices each adding a
> different entry between syncs produces a conflict copy, not a merge. Acceptable
> because the vault is edited rarely and deliberately, and because a conflict
> copy loses nothing. Upgrade path is per-entry merge keyed on the existing
> `VaultEntry.id` + `updatedAt` (`src/shared/vault.ts:29-73`), which the schema
> already supports — but only once someone has actually hit it.

---

## Sync

Content is a small set of **encrypted documents**, one per collection. The list
is derived from `Persisted` rather than guessed: `servers`, `folders`,
`workspaces`, `monitorGroups`, `vault`, `vpn`, `tunnels`, `databases`,
`apiCollections`, `apiWorkspace`, `httpChecks`, `cicdConnections`, `env`,
`knownHosts`, `manifest`. Saved database connections and CI/CD connections are
not an afterthought here — they are precisely the "47 undocumented configuration
decisions" the Context section opens with, and leaving them out would make the
product's own headline story false.

`activeWorkspaceId`, `tabs`, `panes`, `activeTabId` and `tabCwd` go in
`NOT_SYNCED` with the reason "per-device window state; syncing it would fight
the user on two screens" — recorded rather than forgotten.

Each document is sealed client-side to `K_profile_n` and PUT as opaque bytes.

**Every sealed payload carries a signed monotonic counter, and clients refuse to
go backwards.** The roster had rollback protection; the T0 collections had none,
which is the more valuable target — a malicious server could serve last month's
`vault` or `servers` ciphertext and nothing would notice, because it is validly
signed, validly sealed, and simply old. A fresh device, having no pin, would let
the server choose its starting point outright. The counter lives *inside* the
ciphertext so the server can neither read nor forge it.

**Every document carries `{schema, writerVersion}` *inside* the ciphertext.**
Local files may treat an absent key as a default because they only ever move
forward; a shared document does not have that luxury, and two paired machines
will sit on different OpsMaxx versions more or less permanently. Without a
version, this happens and nothing reports it: v0.50 writes `servers` with a new
per-record field, v0.43 reads the document, drops the unknown field on its typed
round-trip, edits one unrelated server, and writes the whole document back — the
field is now gone on both machines. A client below a document's `schema` goes
**read-only for that collection** and shows "update OpsMaxx to sync this",
instead of degrading it silently.

```
GET  /v1/obj/{collection}          → ciphertext + ETag
PUT  /v1/obj/{collection}          If-Match: <etag>  → 409 on conflict
```

Concurrency is **last-writer-wins per collection, with the loser kept as a
conflict copy the UI surfaces**. Not a CRDT.

> `ponytail:` LWW per collection. Two devices editing different servers in the
> same session produce a conflict copy rather than a merge. Upgrade path is
> per-record LWW keyed on the existing record ids, then a CRDT only if real
> usage shows concurrent edits are common. Building a CRDT first would be
> weeks of work defending against a collision two people have not had yet.

The bytes never stream: the existing backup module already notes that a whole
bundle is kilobytes (`src/main/services/backupTargets.ts:22-29`), and the same is
true here. Files and clipboard, which *are* large, go peer-to-peer instead.

---

## What the user sees when it goes wrong

A sync product is judged entirely on its failure states, and every one of these
was unspecified until it was written down. Each is a design item, not a polish
item.

| Situation | What must happen |
|---|---|
| **Emoji mismatch** | Abort, and abort loudly. A mismatch is an active MITM, not a typo. Confirm and Cancel get **equal visual weight** and the mismatch path is the prominent one — a green Confirm beside a small grey "they don't match" link trains people to click Confirm, which is the lesson Matrix learned the hard way. |
| **Wrong / expired code** | Three distinct messages: wrong, expired, and locked out for N minutes. `cliPairing.ts:52` (6 digits, 60 s, 5 attempts) is the shape to match. |
| **Server unreachable** | A visible last-sync age, and the existing backup alarm vocabulary reused rather than reinvented — `BackupAlarmReason` already has `failed \| never \| overdue \| unverified` (`src/shared/backup.ts:675`). A week of silent non-sync that the user reads as "synced" is the worst outcome in the product. |
| **Quota exceeded** | The *user* is told, on the device, with what to delete, and is told the remaining allowance **before** an upload rather than part-way through one. A sync that quietly stops on a 507 is worse than having no sync. Note quota is only meaningful against **backup and transfer bytes** — synced documents are kilobytes, so `addyTarget()`'s `.spbackup` generations are the real consumer and they already have retention. |
| **Conflict** | Two named copies with timestamps and device labels, and a chooser. For `vault` this means two vaults, so the chooser has to say which is which in words a person can act on. **Budgeted in M2, not left to "the UI surfaces it".** |
| **Roster changed** | A notification naming the device — which means the client must decrypt `label_ct` first. A device that is mid-pairing does not yet hold `K_profile`, so that one case falls back to the key fingerprint. Stated because it is exactly the case that gets discovered in QA. |

### Revocation must mean something on the revoked device

A roster entry stops *future* secrets reaching a device. On its own it does
nothing about the complete plaintext estate already sitting in `<userData>` on
the laptop you just handed back — and "revoke" is read by every user as "wipe".

So: a revoked device that comes online reads the roster, sees itself revoked, and
**wipes its local state**. The path already exists — `ALL_DATA_FILES` and
`ALL_DATA_DIRS` (`src/main/services/backup.ts:358`, `:422`) are the authoritative
enumeration of everything OpsMaxx writes. It shows a blocking, unmissable screen
explaining what happened; it does not silently delete itself out from under a
live SSH session.

And the button's own text says the honest thing: **this does not reach a machine
that never comes online again.** For that machine, revocation is only a
guarantee about the future, and full-disk encryption is the control that matters.

### Offline is a promise, not an accident

**addy being down, unreachable or absent degrades nothing except sync.** No
blocking spinner, no disabled panel, no startup wait on a WebSocket, no feature
that silently stops working. This is true today by construction — the modules
default off — but it will not stay true by accident once a sync loop exists, so
it gets one sentence here and one test that boots the app with the addy host
black-holed and asserts a normal startup. It is also the cheapest trust the
document can buy.

---

## Libraries, verified against upstream on 2026-09-15

Every choice checked live; four assumptions were wrong and are corrected here.

| Purpose | Choice | Pin | Note |
|---|---|---|---|
| HPKE (RFC 9180) | `github.com/cloudflare/circl/hpke` | **≥ v1.6.5** | `KEM_X25519_HKDF_SHA256` + ChaCha20-Poly1305. **Must be ≥ v1.6.3** — GO-2026-4550 / CVE-2026-1229 is open below that and `govulncheck` will fail CI. |
| Ed25519 / X25519 | stdlib `crypto/ed25519`, `golang.org/x/crypto/curve25519` | — | CIRCL has both, but these are already transitively in the tree and are the boring choice. |
| SPAKE2 | `salsa.debian.org/vasudev/gospake2`, **vendored** | frozen | Vendored, not merely pinned. It is the most security-critical primitive in the system, unmaintained, and on a single non-GitHub host — the same reasoning that rejected `tyler-smith/go-bip39` applies with more force here, so it cannot be applied to one and waived for the other. Vendor it with the upstream commit recorded, and review it as our own code. |
| SAS emoji table | Matrix `sas-emoji.json`, vendored | 64 entries | Vendored, not fetched — a pairing check that needs the network is not a pairing check. |
| WebRTC | `github.com/pion/webrtc/v4` | v4.2.20 | DataChannels + trickle ICE. |
| TURN | **`github.com/pion/turn/v5` embedded**, coturn optional | v5.1.1 | **Reversed after review.** The requirement says "a built-in TURN server" and "a single binary"; shipping only a coturn container contradicts both. pion/turn v5 has `LongTermTURNRESTAuthHandler` — the identical HMAC-SHA1 `<ts>:<user>` scheme — so addy embeds it by default and `--turn=coturn` points at an external coturn for anyone who outgrows it. Same credential minting either way, so nothing downstream changes. |
| TLS | `github.com/caddyserver/certmagic` | v0.25.4 | `certmagic.HTTPS()` — **not** `Listen()`/`TLS()`, which disable the HTTP-01 challenge. |
| Metadata store | `modernc.org/sqlite` | v1.58.0 | Pure Go, keeps `CGO_ENABLED=0`. ~0.75× cgo SQLite, irrelevant for a relay's metadata. **Correction:** the real failure mode is `SQLITE_BUSY`, not connection-pool sizing — so WAL + a `busy_timeout` + a single writer goroutine, not `SetMaxOpenConns` tuning. Server-side only; its fixed GOOS/GOARCH list makes it wrong for the six-target client sidecar. |
| Object storage | **Garage v2.4.1** | — | See below. |
| S3 client | `github.com/minio/minio-go/v7` | v7.3.0 | Actively maintained (the *SDK* is not the archived thing). |
| BIP39 | `github.com/blinklabs-io/go-bip39` | v0.2.0 | Not `tyler-smith/go-bip39`. |
| Blob/backup encryption | `filippo.io/age` | v1.3.2 | Programmatic X25519 **and** scrypt recipients. |

**MinIO is off the table, not a preference.** `minio/minio` was archived
2026-04-25, read-only; the console was stripped from CE in mid-2025 and official
binaries stopped in October 2025. RustFS is still `1.0.0-rc.6`. **Garage is the
only live option** for a single-node self-hosted S3, which settles the choice the
user left open.

Three Garage consequences that change the design, not just the config:

- **Path-style URLs are mandatory** — `BucketLookup: minio.BucketLookupPath`.
- **No bucket policies** (`PutBucketPolicy` returns 501). Per-user isolation
  therefore **cannot** be delegated to the object store; addy's own authorization
  layer is the only thing standing between one user's prefix and another's. That
  makes `internal/objects` security-critical code and it gets tested as such.
- **No object versioning** (`GetBucketVersioning` is a stub). The LWW conflict
  copy has to be a real, separately named object — which is what was designed
  above anyway, now for a second reason. Conflict copies therefore need their own
  GC; nothing reclaims them otherwise.
- **Garage does not serve a byte until `layout assign` and `layout apply` have
  run**, and access keys come from its admin API. That bootstrap belongs in M0's
  installer, not discovered on first boot. With one bucket and per-user prefixes,
  quota accounting lives in SQLite and will drift after a crash — so quota is
  recomputed on startup rather than trusted.

**`tyler-smith/go-bip39` is deleted from GitHub** (404). Builds still resolve
because the module proxy is immutable, but `GOPROXY=direct` breaks and it will
never be patched. `blinklabs-io/go-bip39` is the maintained revival with the same
API.

**piknik cannot be imported** — every file in it is `package main`. Its protocol
is well documented (XChaCha20-Poly1305 content, BLAKE2b KDF, Ed25519 signatures,
plain TCP), so a compatible endpoint is implementable from the README if someone
wants `piknik` CLI interop. Filed as a nice-to-have, not a v1 dependency; the
clipboard itself goes over WebRTC.

**pion/webrtc in a long-lived daemon has known leak modes**, so `addyd` budgets
for them from the first commit rather than discovering them in month three:
never call `PeerConnection.Close()` from inside a pion callback (deadlocks,
pion/webrtc#2404); enforce an idle/keepalive timeout that force-closes zombie
peers whose state still reads `connected`; watch `DataChannel.readLoop`
(#2098) and SCTP send queues that do not drain on abrupt close (pion/sctp#357);
and export a goroutine count so a leak shows up as a graph rather than an OOM.

---

## Server architecture

Single static Go binary, `CGO_ENABLED=0`. Headless by default; `--ui` serves an
embedded SPA from `embed.FS`.

**What actually runs on the box, stated honestly.** "Single binary" is true of
`addy` and was becoming false of an addy *install*. Embedding pion/turn removes
one container; what remains at rest is **addy + Garage**, and `--dev` runs addy
alone with blobs on local disk. The five deployable services are containers the
user explicitly asked for, not a dependency of the relay — a box that only syncs
never starts one. Docker is required for the wizards and for nothing else.

```
addy/
  cmd/addy/                main, flags, subcommands (serve, panic, reset, selftest)
  internal/identity/       Ed25519 device auth, challenge-response login
  internal/roster/         hash-chained signed device log + verification
  internal/pair/           PAKE rendezvous, rate limiting, emoji SAS derivation
  internal/objects/        E2EE blob CRUD over S3; quota accounting
  internal/profile/        T2 plaintext preference profile
  internal/signal/         WebSocket: SDP/ICE relay, presence, push. Per-account
                           rooms keyed on roster membership; a device may only
                           address a peer already in its verified roster, so an
                           offer cannot be relayed to a stranger. Offers and
                           candidates are signed by the sender's DK_sign and
                           verified by the receiver against the roster — the
                           server is a transport for signalling, not an authority
                           on it.
  internal/turn/           embedded pion/turn v5 (--turn=coturn to externalise)
  internal/relay/          opaque ciphertext fallback when p2p fails, AND
                           store-and-forward for a peer that is simply offline.
                           WebRTC needs both ends online at once; a clipboard
                           that only works when the other laptop is awake is
                           not a clipboard. Short TTL, quota-metered, sealed to
                           the recipient device — the server stores bytes it
                           cannot read and drops them on expiry.
                           On "a reliable proxy library with high throughput":
                           there isn't one to pick, because this is not proxying.
                           It is `io.Copy` between two streams of opaque bytes
                           with explicit backpressure, bounded buffers and a
                           per-account rate cap. The throughput risk is
                           unbounded buffering under a slow reader, and that is
                           solved by bounding it, not by a dependency.
  internal/turnauth/       ephemeral coturn REST credentials. Username is
                           "<unix-ts>:<device-pub>", password is
                           base64(HMAC-SHA1(static-auth-secret, username)) —
                           SHA-1, not SHA-256, because that is what coturn's
                           use-auth-secret mode computes (README.turnserver
                           4.18.0, verified verbatim).
  internal/paste/          one-time paste, bot-proof by construction
  internal/services/       compose templates + wizards for the 5 services
  internal/admin/          users, roles, invite tokens, quota view.
                           The boundary, published as docs BEFORE the UI exists:
                           an admin holds AVAILABILITY and IDENTITY power, never
                           CONFIDENTIALITY. They can delete a user, invite one,
                           change config and see metadata — email, device count,
                           bytes used, last seen — and they can see no collection,
                           no transfer and no paste, because none of it is
                           decryptable to them. Writing that boundary down costs
                           nothing and is most of what earns an operator's trust.
                           "Remove user"
                           deletes their prefix and revokes their tokens; it
                           cannot decrypt anything first, so it is a deletion,
                           not an export — the UI says so, and offers the user's
                           own devices as the only way to get data out.
  internal/notify/         presence-based push over the signalling socket, and
                           nothing else. There is no APNs/FCM path for an
                           Electron desktop app, so "push notification" here
                           means "delivered when the device is online, queued in
                           store-and-forward when it is not". Said plainly
                           because the phrase implies mobile push to most people.
  internal/store/          SQLite metadata (pure-Go driver)
  web/                     embedded UI (built, committed as dist)
  deploy/compose/          docker-compose.yml, install.sh
  deploy/helm/             M6
```

Two roles only: `admin` (add/remove users, see each user's quota number) and `user`.
An admin cannot read user data — the data is ciphertext and the admin has no key.
No telemetry, no governance, no monitoring beyond quota bytes, as specified.

### The one-time paste, and why bots will not eat it

Every one-time paste service dies the same way: you send the link in Slack, Slack
prefetches it to build an unfurl, the paste burns, the human gets an empty page.

- The paste body is **encrypted client-side; the key lives in the URL fragment**
  (`#k=...`), which browsers never transmit. A crawler that fetches the URL gets
  ciphertext it cannot read. This alone makes the feature safe.
- **Burning requires an explicit `POST`.** A `GET` or `HEAD` never consumes it,
  so a prefetch is harmless by construction rather than by user-agent
  guesswork.
- `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`, a `robots.txt`
  disallow, and **no OpenGraph tags at all**, so there is nothing to unfurl.
- **A CSP that stops the portal reading `location.hash`.** The paste is
  same-origin with the portal by design, so any XSS anywhere in the portal reads
  the fragment key of every paste opened in that browser.

Two honest limits, both stated in the UI rather than left to be discovered:
**"one-time" is enforced by the server**, so a compromised one can serve a paste
twice; and **the fragment key does not protect against the origin itself**, which
serves the decryption script. Against a hostile addy a paste is confidential from
crawlers and from the network, not from the server operator.

The user asked for "a custom protocol so no crawler consumes the paste". The
fragment key plus POST-to-burn is that, achieved with plain HTTP — a custom
protocol would need a custom client on both ends and would still not stop a
crawler fetching the ciphertext.

### Compromise mode

`addy panic`, or one button in the portal:

1. Revoke every device session token.
2. Rotate **every credential the box holds**, which review found is a longer list
   than the original three: the TURN shared secret, every frp token, the
   Vaultwarden admin token, headscale's keys, the server-side WireGuard key,
   OpenVPN's CA, the ACME account key, and the object-store access keys. Reissue
   TLS certificates. The rule is that deploying a service on addy means trusting
   the box with that service's credentials, so `panic` must know about all of
   them or it is theatre.
3. Invalidate every outstanding paste.
4. Flag the instance `reonboard-required`; clients refuse to sync until a human
   compares the roster head hash out of band and confirms.
5. Prompt for a **hard re-key** — a new epoch — because a compromise is exactly
   the case a soft revoke does not cover.

`addy reset --hard` wipes SQLite and the object store entirely. This is safe
*because* every client holds the full plaintext locally — addy is a relay, not a
source of truth.

**It also enters `reonboard-required`, exactly like `panic`.** A hard reset wipes
the revocation history, and every client holds a pin that the new, empty chain
fails — so "devices re-push and carry on" was contradictory as written: either
every client refuses to sync, or clients accept an arbitrary new genesis, which
is the rollback attack offered as a feature. The out-of-band head confirmation is
what makes the difference between the two, so a reset requires it.

That safety is also **asserted, and must be shown**. It is also not always true:
it is false for a second user whose devices are offline, and false for a device
mid-recovery that has only half-synced. So the confirm dialog lists **which
devices have checked in recently, per user**, and the operator confirms against
that rather than against a promise. Devices re-push and carry on.

**addy backs itself up too.** `addy export` writes SQLite plus the object store
as a single `age` bundle and `addy import` restores it. Without this there is no
answer to a dead VPS, no instance migration, and no story for the object store
and metadata DB the design otherwise treats as disposable.

### Service deployment — and the honest cost of it

**This feature needs the Docker socket, and the Docker socket is host root.**
Deploying containers, rotating an frp token, reissuing a certificate and
restarting a service all require it. An attacker who owns an addy with services
enabled therefore owns the host and everything on it — so for *that* box, "they
learn your colour scheme" is false for everything outside T0. T0 still holds,
because the keys are not there; nothing else does.

That is not a reason to drop the feature, but it is a reason to be exact:

- **Services are off by default**, and enabling them shows this in plain words —
  not in a doc, at the switch.
- addy talks to Docker through a **socket proxy restricted to the endpoints it
  actually uses**, so a web-layer bug is not immediately host root. A restricted
  proxy is not a security boundary against a determined attacker who already has
  code execution, and the threat model says so rather than claiming otherwise.
- **The recommended deployment runs services on a different box from the relay.**
  The two roles have different blast radii and nothing requires them to share a
  host.
- `THREAT_MODEL.md` states the relay-only and relay-plus-services cases
  separately, with different conclusions, because they genuinely are different
  products in a security sense.

Five services, each an embedded compose template plus a wizard schema declaring
its prerequisites, checked **before** anything is written:

| Service | Needs | Preflight |
|---|---|---|
| frp | wildcard domain, :7000, :80/:443 | DNS resolves to our public IP; ports free |
| headscale | domain, :443 | DNS + cert issuance dry run |
| WireGuard | UDP port, public IP | UDP reachability probe |
| OpenVPN | UDP :1194, PKI | port free; easy-rsa init |
| Vaultwarden | domain, :443 | DNS + cert; admin token generated |

A failing preflight **refuses with the reason** rather than deploying something
half-working. "Informing the user what's needed before they setup" is the
requirement, and a wizard that states a prerequisite and then ignores it is worse
than no wizard.

### Ports and TLS: addy owns the front door

Review enumerated the ports and found the design unbuildable as written. Every
one of these wants the same handful of numbers:

| | Ports |
|---|---|
| addy | **80** (ACME HTTP-01, non-negotiable), **443** |
| TURN | 3478, 5349 (TLS), relay range UDP |
| Garage | 3900-3903 |
| frps | 7000, 7500, vhost **80** + **443** |
| headscale | 8080, 9090, DERP **443** + **3478/UDP** |
| WireGuard | **51820/UDP** |
| OpenVPN | 1194/UDP |
| Vaultwarden | **443** |

Four-way collision on 443, three-way on 80, TURN versus headscale's DERP STUN on
3478, and — the nastiest, because it is intermittent and start-order-dependent —
**WireGuard's 51820 sits inside the default TURN relay range**. Worse, the plan's
own service preflight says "check the port is free", which would fail for every
service, because addy took 443 at install time.

So:

- **addy is the only thing bound to 80 and 443**, and runs an **SNI router**
  there. Portal, paste and API terminate in-process; Vaultwarden and headscale
  are proxied; frps `vhost_https` is **SNI passthrough**, because it does its own
  SNI vhosting and cannot be reverse-proxied by an HTTP server at all.
- The preflight question changes from "is the port free" to **"is this hostname
  already claimed"**, which is the question that was actually meant.
- The TURN relay range is narrowed to an explicit block that excludes 51820, and
  headscale's embedded DERP is off by default — addy already has a TURN server.
- Services bind loopback and are reached through the router; nothing else
  publishes a port.

**Certificates have exactly one issuer and it must export.** `certmagic` keeps
certificates in its own storage, but coturn/pion-TURN (5349), frps and Vaultwarden
need **files on disk**. Without an export-and-reload hook on renewal, TURNS
silently stops working about sixty days after install — the kind of failure
nobody attributes to the right cause. addy is the sole ACME client and writes PEM
to each service's directory on every renewal, then signals a reload.

**Wildcards cannot use HTTP-01.** The frp row asks for a wildcard domain and the
TLS design was on-demand HTTP-01; Let's Encrypt will not issue a wildcard over
HTTP-01, ever. frp therefore requires **DNS-01 with a libdns provider**, which
means the wizard must ask for DNS API credentials and say so *before* the user
starts — or fall back to named subdomains over HTTP-01 and tell them what they
lose. This is exactly the class of prerequisite the wizard exists to surface.

Four of the five services need a certificate for a domain not known at build
time, so certmagic runs in on-demand mode. **Its `DecisionFunc` is mandatory and
must allow only domains an admin has actually configured** — an on-demand config
that returns `nil` unconditionally turns the box into an open certificate-issuance
relay that any stranger can point a DNS record at until the ACME rate limit
trips. `tests` covers the refusal path, not just the happy one.

---

## Client integration in OpsMaxx

The client work follows the house patterns exactly — traced end-to-end from the
CI/CD panel, which is the most recent feature of this shape (commit `81c160e0`).

| Layer | New path | Mirrors |
|---|---|---|
| Shared contract | `src/shared/addy.ts`, `src/shared/addyProfile.ts` | `src/shared/cicd.ts` |
| Module flags | `addyClipboard`, `addyTransfer` only | `cicd` / `cicdTrigger` at `:41` |
| UI | `src/renderer/src/components/addy/` + `addy.css` | `components/cicd/` |
| Feature state | `components/addy/state.ts` | `components/cicd/state.ts` |
| Preload | `addy:` namespace in `src/preload/index.ts` | `:567-635` |
| IPC | `addy:*` handlers under a banner in `src/main/index.ts` | `:1314-1415` |
| Service | `src/main/services/addy/` | `services/cicd/` |
| Backup target | `addyTarget()` in `src/main/services/backupTargets.ts` | `localTarget` `:67` |

**Sync is core, not a module — and there was no choice about that.** A first
draft made `addySync` a module. It cannot be one: sync must import
`services/vault` and `services/secrets`, and both are in
`MODULE_FORBIDDEN_IMPORTS` / `MODULE_FORBIDDEN_BRIDGE`
(`src/shared/modules.ts:686`, `:747`), enforced by a real import-closure walk in
`tests/moduleBoundaries.test.ts`. The module would have turned `main` red on its
first commit.

The precedent is already set and is the right one anyway: **VPN, tunnels and
backup are not modules either.** Only the two genuinely optional UI surfaces —
`addyClipboard` and `addyTransfer` — become modules, and neither needs the vault
bridge, so both stay inside the boundary.

Two further points where the existing code makes this smaller than it looks:

**Backups are cheap to plumb and expensive to get right — the first draft called
them "nearly free" and was wrong.** `BackupTarget`
(`src/main/services/backupTargets.ts:30`) is a five-method interface —
`put/get/list/remove/close` — so the *plumbing* is a fourth implementation plus an
`'addy'` arm on `BackupDestination` and a branch in `destinationProblem`
(`src/shared/backup.ts:372-393`). The scheduler, retention, read-back
verification and alarm logic already exist and are untouched. The authentication
arm is the shortest in the list: an instance URL and a paired device, with **no
vault entry**, because the device key signs the request.

The threat model is the part that is not free, and it is severe enough to gate
the milestone. `buildBundle` (`src/main/services/backup.ts:124-154`) puts into
one object: `opsmaxx-data.json`, the verbatim vault, workspace locks, known
hosts — and `exportSecrets()` (`src/main/services/secrets.ts:60`), which is
**every safeStorage credential unsealed**: SSH passwords, key passphrases,
credential-proxy token values, and the traffic inspector's CA private key. That
payload is sealed with AES-256-GCM under `scrypt(N=32768, r=8, p=1)` — the
*legacy* parameters the vault itself deliberately upgraded away from
(`vault.ts:44` vs `:39`) — with `MIN_PASSPHRASE = 8` (`backup.ts:113`).

Shipped naively, `addyTarget` would hand a compromised addy an offline-crackable
archive of every credential OpsMaxx has ever held, at the strength of an
eight-character passphrase. That single feature falsifies "they do not learn one
credential" more completely than everything else in this plan combined — and in
the original milestone table it landed in M3, two milestones before anyone
thought about compromise.

So, three conditions, all of which gate `addyTarget` shipping at all:

1. **`addyTarget.put()` seals the bundle a second time under `K_profile_n`**
   before it leaves the machine. The server's offline attack then needs the
   account key, not a typed passphrase.
2. **The bundle KDF moves to argon2id**, or at minimum to the vault's own `p=3`.
   A backup should not be weaker than the vault inside it.
3. **`MIN_PASSPHRASE` goes up.** Note `destinationProblem` only *requires* the
   vault-held passphrase for `everyHours > 0` (`src/shared/backup.ts:389`), so a
   manual push takes whatever the user typed — eight characters is a real floor,
   not a theoretical one.
4. **Account key material is excluded from `exportSecrets()`.** `RK` and `AK_n`
   are about to live in `opsmaxx-secrets.json` alongside everything else
   `exportSecrets()` unseals wholesale (`src/main/services/secrets.ts:60`) — so
   without an explicit exclusion the account key ships inside every bundle,
   including the ones uploaded to the server the key exists to defend against.
   The exclusion gets its own test, because this is a one-line omission with a
   total blast radius.

Conditions 2 and 3 improve every existing destination too, which is a reason to
do them rather than an argument against.

Two more, both found by review and both subtle:

**Retention must not be driven by a list the server controls.** `planRetention`
consumes whatever `list()` returns. A malicious addy returns fabricated
future-dated generation names; the planner concludes the real generations are
surplus and returns them in `remove`; the client deletes its own off-site backup
history. The authoritative generation list is therefore held client-side, sealed
as a T0 document, and `list()` is used to reconcile against it — never as truth.

**Restoring an old backup must not rewind the rollback pin.** The pinned `seq`
file lives in the app's data directory, and `ALL_DATA_FILES`
(`src/main/services/backup.ts:358`) is pinned against a *directory listing* — so
a new file is swept into backups automatically and nobody decides to include it.
Restoring a three-month-old `.spbackup` would therefore reinstate a three-month-old
pin on a device that never lost its keys, re-opening the rollback hole. Restore
takes `max(stored, current)`, with a test that fails if it does not.

**WebRTC goes in Go, in a new sidecar — not in Node.** The repo has no WebRTC
dependency and Node's options are poor. It goes in a **new** `sidecar/addyd/`
binary reusing netd's NDJSON-over-stdio protocol shape
(`sidecar/netd/protocol.go:11-23`).

> Deliberately a second binary rather than new methods on `netd`. `netd` can run
> `--privileged` — as root, with a real TUN device (`AuthResult.Privileged`,
> `sidecar/netd/protocol.go:222`). A WebRTC stack parses untrusted SDP, STUN,
> DTLS and SRTP straight off the open internet; that code should not be *loaded*
> in a process that is sometimes root, whether or not it is reached.
>
> **Where the client's crypto runs — one binary, two roles, no shared memory.**
> The plan had not said, and the obvious answers are both wrong: putting `AK_n`
> in the same address space as the DTLS/SDP parser reproduces the exact objection
> that justified splitting from `netd`, while putting it in Node means
> implementing HPKE and SPAKE2 in TypeScript with zero existing dependencies —
> and a second roster verifier, which is a second thing to get wrong.
>
> So `addyd` has two subcommands and the parent spawns both: **`addyd --crypto`**
> holds the keys and never links pion; **`addyd --rtc`** speaks WebRTC and never
> sees a key beyond the session keys handed to it. `tests/addyRoster.test.ts`
> then drives the Go verifier as a harness rather than reimplementing it, and
> M1's "two headless clients pair" becomes answerable.
>
> The cost is concrete and small: six more rows in `resources/bin/manifest.json`
> (sha256-pinned like the rest), one more target loop in
> `scripts/build-sidecar.sh` — which already cross-compiles the same six
> GOOS/GOARCH pairs — and roughly 8-12 MB on each installer, since
> `extraResources` only pulls the one `${platform}-${arch}` directory
> (`electron-builder.yml:71-78`). `netd` itself is ~11 MB for comparison. Worth
> it to keep an internet-facing parser out of the root process.

**One unbudgeted refactor, found by review.** The only manifest-verifying exec
path goes through `resolveBundled()`, and its first line is `kindOf()`
(`src/main/services/vpn/binaries.ts:117`), which **throws** for any name absent
from `ENGINE_KIND` (`:35`) — a `VpnKind` map. So `addyd` would need either a fake
`VpnKind`, which is precisely the union pollution this plan refuses for error
codes, or a lift of `resolveBundled` / `sha256File` / `loadManifest` /
`bundledRoot` out of `services/vpn/` into a neutral module. Do the lift, budget
it in M3, and check that `BUILD_SCRIPT` (`:74`) names the right script for the
new binary — that file has already learned that lesson once.

`sidecar/netd/protocol_test.go` asserts that every Go error-code constant exists
in the TS `VpnErrorCode` union. `addyd` gets its own `AddyErrorCode` union in
`src/shared/addy.ts` and its own equivalent test, rather than polluting the VPN
union with codes that have nothing to do with VPNs.

### Bitwarden: deploy it, never link it

The idea of adopting the Bitwarden client inside OpsMaxx — instead of, or beside,
our own vault — was evaluated properly and **rejected**, for three independent
reasons, any one of which would be sufficient. Recorded here with the citations
so it does not get relitigated in six months.

**1. Licensing is fatal, and this repo has already litigated the identical
question.** OpsMaxx is **MIT** (`LICENSE:1`, `package.json`). The package the
Bitwarden clients actually depend on, `@bitwarden/sdk-internal`, is published on
npm under a single **GPL-3.0** declaration. Linking it into an Electron app that
is publicly distributed means relicensing OpsMaxx; the alternative Bitwarden SDK
License branch is worse, since it forbids Compatible Applications being "offered,
licensed, or sold to a third party" at all. There is no branch under which a
publicly distributed MIT desktop app can link it.

That is not a new argument here. `docs/plans/vpn-tunnel-clients.md:147-149`
already ran this analysis for GPL-2.0 `openvpn` and concluded it may only be
driven as a **separate process** over its management socket — mere aggregation,
"so OpsMaxx stays MIT" — explicitly rejecting the bundled-and-linked option.
`THIRD-PARTY-NOTICES.md:239` states that no GPL, AGPL, LGPL, SSPL or proprietary
dependency exists anywhere in the tree, and `tests/bundledEngineLicensing.test.ts`
exists to keep it that way. Adding the SDK would turn `main` red on the first
`npm install`.

**2. It would make the credential path async and network-dependent.**
`vaultEntriesForResolve()` (`src/main/services/vault.ts:331`) is a **synchronous
in-memory read** of the decrypted cache, and every background consumer depends on
it — scheduled backups, CI polling, monitor sweeps, reconnects. A
Vaultwarden-backed vault makes each of those a network call that fails when the
server is down or a token expired. `SECURITY.md:132-136` documents that exact
regression as one this product already had and already fixed: a monitoring tool
that stopped monitoring because nobody had clicked anything. The three-stage
lock model exists precisely to keep a key resident for unattended work, and
Bitwarden's locked/unlocked model has no equivalent of `secured`.

**3. It would hand the untrusted party the keys to the vault.** Bitwarden clients
fetch KDF type and iteration count from the server (`/accounts/prelogin`) *before*
deriving the master key, and the server receives a login hash that is a direct
offline verifier. Hosting or proxying Vaultwarden on addy therefore lets a
compromised addy declare a trivial iteration count for a password a human types,
while already holding the protected symmetric key and every ciphertext. One
compromise plus one unlock yields the whole vault — the exact property T0 exists
to deny. **So Vaultwarden is never co-located with addy's relay role.**

It also would not reduce the number of secrets a user holds: mnemonic + vault
master password + backup passphrase either way. Swapping one independent-password
vault for another buys a second crypto stack and an RSA sharing path we do not
need.

**What survives, and it is not nothing:**

- **Deploying Vaultwarden as an unmodified upstream container costs nothing.**
  AGPL-3.0's §13 network clause binds whoever operates a *modified* version;
  neither addy nor the self-hoster modifies it. This is the same
  separate-process pattern the repo already uses for `openvpn` and `frpc`, and
  it is why the service wizard stays in the plan unchanged.
- **The ecosystem argument nets to zero anyway.** Browser extensions talk to the
  *server*. A user running the Vaultwarden that addy already deploys gets the
  extension ecosystem regardless of what OpsMaxx's vault does internally, so
  adopting the client buys nothing there.
- **The migration argument mostly evaporates**, and the harvest quantified it.
  Chrome/Edge/Chromium export `name,url,username,password,note`. Apple Passwords
  exports `Title`, `Url` *or* `URL` (both spellings occur in the wild — handle
  both), `Username`, `Password`, `Notes`, `OTPAuth` (a full `otpauth://` URI,
  which is why Apple round-trips 2FA and Chrome does not). Of Bitwarden's ~79
  importers, about 60 are single-file CSV/XML/JSON readers of roughly 35 lines —
  Chrome's is five field assignments and one regex. Only about eight are real
  work (1Password's `.1pux`, LastPass, Dashlane, Enpass, Proton Pass, Keeper,
  Psono, Netwrix). Build the pipeline once and each format is an afternoon.
  Better: the formats *nobody* implements are the ones our audience actually
  has — `ssh_config`, `.env` files, kubeconfig — and those are ours to own.
- **Reimplementing a documented protocol or wire format from its spec is fine**
  and is where the real savings are — see the next section.

### What we borrow anyway: four designs, one deviation, two rejections

Bitwarden has run these in production for years. Copying the *designs* costs us
nothing legally and saves months of rediscovering their failure modes.

**The rule that makes this safe, stated once.** addy ships its own clients, so we
need Bitwarden *wire compatibility* nowhere. That single fact means **we never
borrow a format, only a design** — and since the designs live in published prose
(the security whitepaper, the help centre, the architecture deep-dives) rather
than in the code, the licensing risk goes to roughly zero. We take the mechanism
and invent our own field names. Reading AGPL or GPL code to understand a
mechanism is fine; what we write must not be a transcription of it, and nothing
we ship links any of it.

Two things are therefore deliberately **not** borrowed, because they exist only
in code: every JSON field name and enum numbering, and the SignalR/MessagePack
framing. There is also no published OpenAPI for Bitwarden's internal vault API —
the community spec that exists is GPLv3, one commit, self-described WIP — so
nothing is built on it.

**Send → our one-time paste. BORROW, with one deliberate deviation.**
Their core is sound and we adopt it: a **128-bit CSPRNG key in the URL fragment**,
HKDF-SHA256-expanded to 512 bits and split with **distinct `info` labels into
separate encryption and MAC keys**. That split is exactly the domain separation
our paste spec was missing, and the whitepaper is explicit that the fragment
never reaches the server.

**It encrypts the metadata too** — name, notes, filename — not just the body. We
copy that without argument: a paste whose *filename* is readable by the server is
a leak with extra steps, and this is the kind of detail that is obvious in
hindsight and expensive to retrofit.

The deviation is their **optional password**, which gates *server-side access*
and is never mixed into the key. Copied verbatim we would ship something users
read as a second factor and that a compromised addy simply ignores. So ours runs
the password through **Argon2id client-side and mixes it into the HKDF IKM** — the
ciphertext is undecryptable without it no matter what the server permits.
Max-access-count and expiry stay, labelled in the UI as availability hygiene and
never as security, because they are server-enforced. The OpsMaxx desktop client
is the first-class reader; the web page remains a convenience that is assumed
hostile.

**Account key rotation → our epoch rotation. STUDY-ONLY, but four lessons we take
directly.** Their shape does not fit — they re-wrap every cipher, folder, send and
the RSA private key in one enormous call, which historically was not atomic. The
lessons transfer exactly:

- **The commit point is the roster, and only the roster.** Write every re-sealed
  object under epoch *n+1* names first; append the signed epoch-transition entry
  **second**; delete the old objects third. Clients key off that entry, so a
  server cannot half-apply a rotation.
- **There are two rotation types and conflating them is the bug waiting to
  happen.** A *hygiene* rotation may seal `AK_{n+1}` under `AK_n`, so an offline
  device catches up through the chain. A *revocation* rotation **must not** —
  chaining would let the revoked device follow the rotation straight through. A
  device that was offline across a revocation re-pairs, full stop. This is
  written in the spec because otherwise someone implements one code path.
- **The epoch number goes in the AAD** of every sealed object, so an epoch-*n*
  ciphertext cannot be replayed as epoch *n+1*. Monotonic in the chain; clients
  refuse a lower one.
- **Rotation is forward-only.** A revoked device keeps `AK_n` and everything it
  already downloaded. Already stated; this confirms it from production.
- **The server validates that a rotation is COMPLETE, and this is the one that
  prevents permanent data loss.** Bitwarden's server rejects a rotation unless the
  ids the client supplies are a *superset* of the ids the server already holds,
  because a client cannot be trusted to know what it owns. The reason is a real
  incident (`bitwarden/clients#7709`): a sync silently failed, the user saw an
  empty vault, rotated their key against that empty view, and **permanently
  orphaned every server-side item.** No path back.

  This maps onto addy perfectly, and — pleasingly — needs no decryption to
  enforce. Collection names and object ids are T1 metadata the server already
  holds, so **addy refuses an epoch transition that does not re-seal every object
  it knows about**, and names the missing ones. A half-synced device attempting a
  rotation gets a refusal, not a silent amputation. It is a cheap check standing
  in front of an unrecoverable failure.
- **Sessions die atomically with the epoch.** Bitwarden carries a "security
  stamp" UUID in every JWT and resets it on rotation, invalidating all sessions at
  once, with a narrow exception that keeps the *initiating* client alive mid-
  rotation. A stale-key session that writes during a rotation reproduces exactly
  the corruption above. Our epoch counter is that stamp generalised — it goes in
  the session token, and the same initiating-client exception applies.
- **Refuse to change two things at once.** Vaultwarden rejects a KDF-variant
  change or an email change bundled into a rotation. Our equivalent: an epoch
  transition changes the epoch and nothing else — no schema bump, no collection
  added or removed in the same operation.
- **Vaultwarden's own rotation is not atomic** — there is a literal `TODO` about
  wrapping it in a transaction. We already have the better answer in the commit
  ordering above; this is confirmation that getting it wrong is the default
  outcome, not a hypothetical.

**Emergency access → our second recovery door. BORROW the social shape, REJECT
the waiting period.** Cryptographically theirs is just a second RSA-OAEP
recipient, which is no better than the second HPKE/age recipient we already have.
The "trusted contact, waiting period, grantor can reject" state machine is
**server-enforced** — the same defect as the pairing limiter, and a compromised
addy releases immediately while suppressing the grantor's notification. So we
take the named-contact UX and the notify-every-device behaviour, implement the key
half as a plain second recipient at setup, and never present a server timer as a
security control.

**Trusted device approval → mostly we are ahead, one thing to take.** Their
approval asks "does this device look plausible?" with no SAS at all; SPAKE2 plus
emoji is strictly stronger. But we **take their pending-request model**: an
approval request appears on *every* trusted device, not only the one that started
it. That converts an unnoticed pairing attempt into a visible one, and it is
cheap. Their mechanics are worth copying too: the requesting device mints a
**throwaway keypair** that exists only for the life of the request, so
cancellation is implicit — a short TTL expires it and there is no state to clean
up — and **any device can enumerate the open requests**, which is the audit
surface. We **reject** admin/organisation account recovery outright: it is a
deliberate backdoor and the exact inverse of the roster's premise.

One deliberate simplification: **we ship exactly one fingerprint-phrase concept.**
Bitwarden has two and its own docs disclaim the resulting confusion. Ours names
the roster head and nothing else.

**The notifications hub → our sync push. BORROW-DESIGN, ignore the transport.**
Theirs is SignalR over MessagePack, which we have no reason to adopt — we already
have a WebSocket. The *model* is the valuable part and we take it whole:

- **Notifications are pointers, never payloads.** A message says "object X changed,
  revision R" and nothing else; no ciphertext rides the notification channel. The
  client compares its local revision and either skips or fetches that one object.
  This keeps the push path cheap and means a dropped notification is never a
  correctness problem.
- **Each notification carries the acting device id, and clients drop their own.**
  Free echo suppression, one field, no bookkeeping.
- **On every reconnect, do a full catch-up sync** rather than trusting that
  nothing was missed while disconnected.
- **Keep an explicit "just resync everything" message.** An escape hatch that
  costs nothing and is the only thing that saves you when the incremental path
  has a bug in the field.
- **A 404 on fetching a changed object means it was deleted**, not an error.
- Reconnect backoff in *seconds with jitter*. Theirs is 2-5 minutes because they
  are protecting a cloud service from a thundering herd; a self-hosted relay with
  one user's devices has the opposite requirement.

**One-time is a counter, not a flag.** Their "one-time" Send is just
`max_access_count = 1`, enforced by a conditional increment that only fires while
below the maximum — so concurrent reads cannot overshoot. Three genuinely
orthogonal axes, which we copy: an **expiry** after which access stops but the row
lives, a **deletion date** after which it is purged, and an **access count**. Also
worth copying: a *separate serializer* for the anonymous view, so the public
projection cannot accidentally inherit a field someone adds to the owner's model
later. And for files, count the access at download rather than at metadata fetch,
or every link preview burns a paste.

**CrossPaste's shape → our continuity pipeline. DESIGN-ONLY, and that is the
whole point.** CrossPaste is **AGPL-3.0** with no dual-license offer, so it is a
design reference and a bug catalogue, never a dependency — and being Kotlin/JVM
against our TypeScript and Go, that costs us nothing we wanted. We take notes and
write our own code, with our own domain-separation strings rather than theirs,
since we want no wire interop with it.

**SyncClipboard, by contrast, is MIT — and it publishes protocol specs.** Its
`docs/Hash.md` and `docs/S3-Adapter-Design.md` are written explicitly so third
parties can build compatible clients, which makes them a reusable artifact rather
than something to be reverse-engineered. So where CrossPaste is read-only
inspiration, SyncClipboard's content model and hashing rules can be **ported
directly, with attribution**.

What we take from it is the *content* layer only. Its trust model is the exact
opposite of ours and must not be copied: there is no pairing and no device
identity, a "device" is anything knowing a URL and one shared password, the
server has a single hardcoded user, and the entire wire protocol is one mutable
JSON file the server reads in the clear. That is a perfectly reasonable design
for what it is, and precisely what our threat model exists to rule out.

One structural idea does transfer: it hides WebDAV, S3 and its own server behind
a single server interface, with polling-driven and event-driven wrappers over the
same adapters. That is the same seam we just drew for transport, arrived at
independently — a good sign the seam is in the right place.

Two things are worth taking from CrossPaste:

- **The pipeline shape: capture → normalising plugin per content type → a durable
  row → a task queue → transport.** Transport is the *last and thinnest* layer.
  This is the opposite of how one naturally builds it — transport-first — and it
  is why their content handling is pluggable and ours would not have been.
- **A persisted task queue with retry and failure bookkeeping.** Theirs lives in
  SQLite with typed tasks (sync a paste, pull a file, pull an icon, clean up).
  This is the piece that makes continuity survive a restart mid-transfer, and it
  is exactly the sort of thing that gets retrofitted painfully after the first
  bug report about a file that silently never arrived. Our store-and-forward
  design needs it anyway.

**An SSH agent backed by the vault — the biggest single win in the whole
harvest, and it is not really an addy feature at all.** "SSH key hell" is at the
top of the pain list, OpsMaxx already owns SSH end to end, and the vault already
stores private keys as PEM (`VaultEntry.privateKey`, `src/shared/vault.ts:60-68`).
An agent that serves those keys — with per-use approval, and with the key material
synced across devices as part of the `vault` collection — turns "Laptop B doesn't
have the key" into a non-event. It also works with no addy at all, which makes it
independently valuable rather than a bet on this whole plan landing.

Crucially, **the protocol is a public specification**, not something to be read
out of anyone's GPL source: `draft-miller-ssh-agent` plus the OpenSSH extensions
`session-bind@openssh.com` and `restrict-destination-v00@openssh.com`. Implemented
from the spec this is unambiguously clean.

What we take from Bitwarden's version is the *architecture*, which their crate
documents publicly in its own README:

- **Two interfaces keep it testable.** An authorization policy and an approval
  requester. The protocol server knows nothing about vaults; the vault logic
  knows nothing about the UI. For us that is one policy function in main and an
  IPC approval promise to the renderer — and it means the protocol layer can be
  unit-tested with no vault and no window.
- **One protocol core, three listeners.** Unix socket on macOS and Linux — with
  the path varying by packaging, which is the part everyone gets wrong (Snap,
  Flatpak and sandboxed builds each need their own) — and on Windows a named
  pipe at OpenSSH's own `\\.\pipe\openssh-ssh-agent`, so existing tooling finds
  it with no configuration.
- **Pre-create the next pipe instance before handing off the accepted one**, or
  the pipe name briefly stops existing and clients racing to connect get a
  failure that is maddening to reproduce.

- **Sign always requests approval, at the policy layer, unconditionally.** Every
  relaxation — "don't ask again", cached approvals — lives in the renderer, never
  in the policy. Secure default in the core, convenience in the UI, and the two
  never trade places.
- **The approval prompt names the key**, because the request carries the vault
  entry id. A prompt that cannot say *which* key is being used trains people to
  approve reflexively.

Estimated 8-12 days, lower than it looks because `ssh2` is already a dependency,
its `AgentProtocol` has a server mode, and its `parseKey` handles PPK. Worth
going beyond Bitwarden here: bind `session-bind@openssh.com` and the peer process
so the prompt can say *who* is asking and *which host* they are connecting to.

Scope-wise this is **not** smuggled into v1. It is a named roadmap item with its
own argument, and it is listed here because it is the thing most likely to be
worth more than several features already in the table.

**Two findings that apply to code already shipping, independent of addy.**
Recorded here because they were found during this work and should not be lost in
it:

1. **`secured` needs a capability axis, not just a timer.** Bitwarden
   distinguishes *before first unlock* from *after first unlock*, because PIN and
   biometric material only exists once a vault has been opened at least once. We
   will hit this the first time someone restarts the app and Touch ID silently
   stops offering itself. Two cheap additions alongside: Electron's `powerMonitor`
   gives `lock-screen` and `suspend` as triggers for one line each, where
   `setVaultAutoLock(minutes)` is time-only today; and *when* to time out and
   *what* to do about it are orthogonal, so they should be two settings rather
   than a hardcoded secure-on-idle. An agent forces all three questions, which is
   another reason to sequence it after they are answered.
2. **The loopback HTTP servers should reject browsers outright.** OpsMaxx runs
   several: the MCP server on 127.0.0.1:5177 (`mcpServer.ts:5719`), the
   credential proxy on 5178, and the RDP relay. `bw serve` guards its local
   endpoint with two things we should copy — a **Host header allow-list**, which
   defeats DNS rebinding (an attacker resolves `evil.com` to 127.0.0.1 and the
   browser dutifully sends `Host: evil.com`), and **rejecting any request that
   carries an `Origin` header at all**, which is an unfalsifiable "you are not a
   browser" check with no allow-list to maintain. Bitwarden added both after
   being burned; taking the fix costs about half a day. addy's own loopback
   surfaces get the same treatment, and can go further — a unix socket at `0600`
   with `SO_PEERCRED` identifies the calling process, not just its uid.

**Quota, and the version of it that cannot drift.** Bitwarden sums live usage on
every upload rather than keeping a counter — no stored total means no counter
drift, at the cost of a scan per write, which for a relay's volume is free. Three
details we take with it: the remaining allowance is applied as a **hard cap on
the reader**, never trusted from `Content-Length`; a *reserved-but-unwritten*
row from an aborted upload is the one real drift window, so it is reconciled on a
timer; and **`0` means disabled while unset means unlimited**, which are
genuinely different and get confused every time they are not named apart. The
client is told its remaining quota — a silent failure part-way through an upload
is the worst version of this feature.

**The invite row *is* the authorization.** The non-obvious trick worth stealing:
an invitation record is itself permission to register, bypassing "signups
disabled" entirely. That means an instance with no mail server, or an air-gapped
one, can still onboard a second user — the admin creates the invite and hands
over the token by any means they like. It costs almost nothing and removes the
SMTP dependency from the only multi-user path we have. The related three-state
config idiom — unset / `none` / an explicit list — is a good shape for our own
capability switches.

**Key commitment, extended.** Commitment matters wherever an attacker holds
ciphertext and is guessing among candidate keys — which is to say, wherever the
key comes from a human. So it applies to the escrow blob (already required), the
`.spbackup` passphrase envelope, and a password-protected paste. It is not needed
for collection documents sealed under a random `K_profile_n`, and pretending
otherwise would just add ceremony.

### Vaultwarden as a vault backup source

**Direction corrected after review.** The requirement is Vaultwarden as a
*source* — somewhere to restore **from** when the vault is gone — so the read
path is the feature, not an afterthought. Both directions exist and they are not
symmetric:

- **Push (making the backup):** OpsMaxx exports vault entries as
  Bitwarden-compatible JSON and writes them to the user's own Vaultwarden over
  its API.
- **Pull (the actual requirement):** OpsMaxx reads a Vaultwarden vault and
  imports entries into its own, with a preview-and-choose step rather than a
  blind merge.

Authentication uses credentials held in the OpsMaxx vault itself, so **addy never
sees any of it** — it deployed the container and knows nothing further.

**Scoped honestly after review: this is not "export JSON and POST it".** Talking
to Vaultwarden means implementing Bitwarden's client crypto — fetch the account's
KDF parameters, derive the master key, HKDF-stretch it, unwrap the protected
symmetric key, then handle per-field AES-256-CBC + HMAC-SHA256 `EncString`
values, plus `/identity/connect/token` with the right device headers. That is a
two-to-four week cryptographic sub-project with its own correctness risk, and it
was sitting in a milestone table as one row.

So: **read-only import ships first**, because that is what the requirement
actually asked for, and push follows. Continuous two-way sync stays out of scope
permanently — conflict resolution between two password managers is a problem
nobody asked for.

### The overlay network is mostly already built

"One-click overlay for all addy devices" reads as new work and largely is not:
`sidecar/netd/go.mod:11` already carries `tailscale.com v1.102.3` and drives it
through `tsnet`, with a full driver at `src/main/services/vpn/drivers/tailscale.ts`
and per-OS DNS, routing and elevation layers beside it. The client half exists
and is shipping.

What is missing is the **control plane**: headscale deployed by the service
wizard, addy minting preauth keys per device off the roster, and one button that
joins every device in the account. That is a wizard plus a key-minting endpoint,
not a VPN implementation.

### Hot device

The manifest is a T0 synced document. v1 restores **OpsMaxx's own** state —
servers, workspaces, vault, VPN profiles, tunnels, preferences, known hosts —
which already covers the CONNECTIVITY and PERSONALIZATION blocks of the brief and
is the part addy can guarantee. Broader environment provisioning (package
managers, runtimes, IDE extensions, dotfiles) is client-side work with per-OS
drivers and lands in M6; the manifest format is designed in M3 so it does not
need a breaking change later.

### The transport is behind one interface, and tailcat gets a spike

Tailscale open-sourced **`tailcat`** (BSD-3-Clause) in August 2026: their actual
data plane — WireGuard, magicsock NAT traversal, DERP relay — as an importable Go
package with no control plane and no accounts. `croc` v11.3 already ships it.
`tailscale.com` is *already* a direct dependency of `sidecar/netd` for the overlay
feature, so this is not a new supply-chain bet.

If it works, what drops out is large: pion/webrtc, pion/turn, coturn, all ICE and
SDP signalling, TURN credential minting and rotation, and the entire SCTP
chunking problem. What stays is everything that matters — SPAKE2 pairing, the
signed roster, HPKE, presence, store-and-forward. What it buys is magicsock:
years of tuned path discovery and hole punching, against generic ICE we would be
tuning ourselves, with DERP serving as both the hole-punch side channel and the
relay of last resort rather than a bolted-on fallback.

**The decision now is not tailcat; it is the seam.** Regardless of which wins,
define one internal interface — `Dial(peer) (net.Conn, error)` plus an accept
side — and put *everything* behind it. HPKE framing sits above it; a tailcat
adapter and a pion adapter sit below. A pion data channel wraps to a `net.Conn`
easily enough. That seam costs nothing, is good design on its own, and converts
an irreversible architecture bet into a swappable one.

Then spike tailcat for about three days, shipping nothing, and resolve in order:

1. **A version conflict that is a shipping-stability question, not a research
   one.** tailcat's `go.mod` pins `tailscale.com v1.103.0-pre...`, a pre-release
   *ahead* of netd's v1.102.3 — Go's minimal version selection would drag the
   existing overlay feature onto an unreleased commit.
2. **Whether tailcat and `tsnet` can share a process at all.** Both drive
   magicsock. Assume they cannot until proven otherwise.
3. Direct-connect rate against the two worst NAT cases, measured, not assumed.
4. Whether the module bloat is tolerable — it is one module carrying both library
   and CLI, so importing it pulls `chromedp`, `gliderssh`, `pkg/sftp`, `u-root`,
   `gvisor` and `creack/pty`. All permissive, none a licensing problem, but a
   large surface for what should be a pipe.

**The load-bearing assumption, written down because everything rests on it:**
tailcat has no browser peers, and we are asserting that continuity is
desktop-to-desktop forever. The portal is assumed hostile and never a continuity
endpoint. If that assumption ever changes, we are back to pion — which is
precisely why the seam above is not optional.

**Crypto composition — one identity, not two.** tailcat brings its own keys
(WireGuard public key, a path-discovery key, an independent PSK). Those are
**transport** keys; roster keys are **authorization** keys, and conflating them
would give us two competing notions of device identity. So: **the roster remains
the sole identity**, and a roster entry *carries* the peer's tailcat address as a
signed attribute. A node key is a rotatable transport attribute of a device,
never a device. We never accept a peer because its node key is familiar — only
because the roster says so. And **HPKE stays** regardless: WireGuard's encryption
is between two endpoints on a path, ours is end-to-end and path-independent, so
it survives a transport swap unchanged.

One operational note: public DERP is best-effort with fairness limits, so
anything we promise runs on our own DERP nodes.

### Protocol details that must be pinned before M1 code

Each of these is somewhere the plan was underspecified in a way that invites the
obvious wrong implementation. They belong in the M1 spec with test vectors, not
in a reviewer's comment later.

- **Distinct HKDF `info` labels** for every derived key, with the account id and
  epoch mixed in, and a genesis salt. The Ed25519 seed and the X25519 scalar are
  separate outputs, never the same bytes used twice.
- **A key-committing construction for the escrow blob.** ChaCha20-Poly1305 and
  HPKE's AEADs are not key-committing: a ciphertext can be made to decrypt
  successfully under two different keys. That matters exactly where a wrong key
  must fail loudly rather than yield plausible garbage — recovery from a printed
  card, against a server that chooses which blob to serve. Either commit
  explicitly (hash the key into the AAD) or use an encrypt-then-MAC construction
  there. Noticed while evaluating Bitwarden's `EncString`, which gets this
  property for free; the lesson applies to our own design regardless of what we
  decide about Bitwarden.
- **Canonical serialisation for anything signed.** Length-prefixed binary with a
  `"addy-roster-v1\0"` domain prefix — not JSON, which invites a
  sign-over-one-encoding, verify-over-another bypass. Account id and epoch appear
  in every entry, and the chain hash covers the signature, not just the body.
- **The escrow blob is defined by what is *not* derivable.** As drafted it held
  the roster (public and signed) and collection keys (derivable) — so it was
  either dead weight handing the server a second chain to choose between, or the
  hierarchy diagram was incomplete. Under the epoch design it is neither: it
  holds **`AK_n`, which is random and cannot be derived from the mnemonic**,
  sealed to `RK_enc`, with the signed roster head and a monotonic counter beside
  it.
- **`DK_sign` never signs a bare server-chosen challenge.** As drafted, the same
  device key signed both login challenges and request authorizations, and the
  server picks the challenge — a chosen-message oracle across two different
  purposes. Every signature carries a **purpose prefix and a client-contributed
  nonce**, with four distinct purposes (login, request authorization, roster
  entry, signalling) that cannot be substituted for one another.
- **Signalling is signed and bound.** Offers and answers carry a `DK_sign`
  signature over `{DTLS fingerprint, peer public signing key, roster head,
  nonces}`, and a non-roster signer is rejected. Without the fingerprint in the
  signed blob a malicious relay simply swaps it and reads the clipboard, the
  files and everything else on the data channel.
- **DataChannel payloads are HPKE-sealed regardless of path.** Then p2p and
  relayed transport are cryptographically identical, and "did it fall back to
  the relay?" stops being a security question.

---

## Getting it in front of a person

Self-hosted products die in the first ten minutes, and three gaps in that window
were unspecified.

**The join string.** Nothing in the design carried the instance URL from the
server to the first laptop. The portal prints an `addy://` string containing the
instance URL **and a TOFU pin of its certificate**; the client takes it as a
paste or a QR. Without this the first step of the entire product is "type your
domain correctly and hope you are talking to your own server".

**`addy serve --dev`.** A localhost mode with a self-signed cert and no domain,
in which two OpsMaxx profiles pair in under a minute. Nobody will buy a VPS and
point a DNS record at it to find out whether they like the feature, and the
current design offers no other way to try it. This also gives the test suite its
harness for free.

**Preflight addy the same way addy preflights its services.** `certmagic`'s
HTTP-01 needs port 80 reachable and DNS already live *at install time*; coturn
needs a UDP relay range (49152-65535) that most VPS images leave default-denied.
The installer checks both and **refuses with the reason** — the same discipline
the service wizards are held to, applied to the installer itself, because a
half-installed relay that starts and cannot relay is the worst possible first
impression. `addy selftest` proves TURN actually **relays a packet**, not merely
that the daemon started. The installer also has a non-interactive mode and states
a minimum box size.

**Release hygiene is inherited, not rediscovered.** The new repo copies this
one's `.github/workflows/release.yml` discipline from the first tag — signing,
scanning, a SHA-256 table in the notes. A security product whose own binaries
ship unsigned undercuts the entire pitch.

**External review.** An independent cryptographic review of M1 before M2 starts,
and said publicly. The product asks people to put every credential they own
behind a design; "trust us, we thought about it carefully" is not enough, and it
is far cheaper to hear the findings before four more milestones are built on top.

---

## Milestones

Each ends with something that works on its own.

| # | What | Ends when |
|---|---|---|
| **M-0** | **Commit this document.** Verbatim, in full, to `docs/plans/addy.md` in the OpsMaxx repo — and, once `OpsMaxx/addy` exists, to `docs/DESIGN.md` there. It is the design of record and most of its value is in the corrections, which are exactly what is lost when a plan lives only in a chat log. | The file is in git and reviewable in a PR |
| **M0** | Repo, CI (incl. `govulncheck`), cross-compile, compose installer with its own preflight, Garage `layout assign`/`apply` bootstrap, SNI front door, `--dev` mode, `--ui` skeleton | `curl \| sh` on a fresh VPS gives a TLS portal that says hello; `--dev` pairs two local profiles |
| **M1** | **The crypto spine** — genesis/account creation, identity, roster, SPAKE2 pairing, emoji SAS, HPKE distribution, BIP39 recovery, invite tokens. Written protocol spec with test vectors. | A device mints an account from nothing, a second pairs and verifies emoji, and a third is refused |
| **M2** | Object sync, schema versioning, **the conflict chooser**, T2 profile, quotas, object store, admin/invites | A document round-trips E2EE; a deliberate conflict produces two named copies and a working choice; admin sees byte counts and no content |
| **M3** | Client integration — `addyd --crypto` / `--rtc`, the `resolveBundled` lift, addy panel, `addyTarget()` **behind its four preconditions**, restore, **revocation wipe**, the failure surfaces above | A second OpsMaxx install restores from addy; a revoked device wipes on next launch; no bundle leaves a machine singly-sealed |
| **M4** | WebRTC continuity — clipboard, file send, embedded TURN, **store-and-forward for offline peers** | Copy on Mac, paste on Linux, p2p; and copy on Mac with Linux asleep, paste on Linux when it wakes |
| **M5a** | Service wizards ×5 | Five services deploy, each refusing on a failed preflight |
| **M5b** | Compromise mode | `addy panic` rotates every addy-held secret |
| **M5c** | One-time paste | A link survives Slack unfurling and burns only on a real read |
| **M6** | *Roadmap, not a milestone* — **vault-backed SSH agent**, hot-device provisioning, Vaultwarden import, Helm, overlay one-click | Sized when M5 lands |

M1 is the gate. Nothing in M2–M5 is safe to build on a spine that has not been
specified and adversarially tested first.

**Four corrections to the original sizing, from review:**

- **M5 was three products in one row**, so it is split. Each is genuinely
  separate work: five wizards (OpenVPN's preflight is a PKI with renewal and a
  CRL; headscale wants ACLs), a compromise mode, and a paste service with its own
  web client, crypto and abuse surface. Note that `panic` over **addy's own**
  secrets is about a day — it is rotating live secrets *across five running
  services* that turns into a config-management engine, which is harder than
  deploying them was. Scope `panic` to addy's own secrets first.
- **M4's hard part is capture, not transport.** The WebRTC pipe is the easy half.
  Wayland has no universal clipboard-read path (portal or compositor-specific),
  and macOS screenshots need Screen Recording TCC — a prompt, a trip to Settings
  and an app restart. So v1 ships **explicit send/receive on a keystroke**, not
  ambient clipboard mirroring. Ambient sync is a per-compositor research project
  wearing a feature's clothes.
- **M1 needs a Go reference client**, which the original table did not fund until
  M3. Its own end condition ("two headless clients pair") requires it, and so do
  `selftest` and the compose integration test. Budget it in M1.
- **M6 is a roadmap, not a milestone.** "Hot-device provisioning" in one row is
  Ansible plus nix-darwin plus chezmoi. v1 restores OpsMaxx's own state plus a
  user-written post-restore hook; the manifest format still lands in M3 so the
  hedge costs nothing.

Honest reshape: **M0–M3 is four to five months on its own.** M4 is about two more
once the OS capture matrix is real. The sequencing in this table is right; the
original box sizes were not.

---

## Verification

**Server.** `go test ./...` plus `govulncheck` in CI (it is what catches a CIRCL
pin drifting below v1.6.3). `addy selftest` runs a full
pair → sync → revoke → recover cycle against a local instance in one command.
A compose-based integration test brings up addy + Garage + coturn and pairs two
headless clients over real ICE.

`internal/objects/isolation_test.go` is the second load-bearing test. Garage has
no bucket policies, so nothing below addy enforces the boundary between two
users' data — every cross-user read, write, list and delete must be refused by
addy's own authorization layer, with a test per verb. A store that cannot help
means the tests are the only backstop.

**The test that matters most** — `internal/roster/adversary_test.go`, a
deliberately malicious server harness. The client must refuse all of:

1. a roster entry the epoch key did not sign;
2. a chain whose `prev_hash` does not link;
3. a chain rewound to a lower `seq` than the client has already seen;
4. a real device's entry with a substituted `pub_enc`;
5. a PAKE peer that fails the SAS comparison;
6. **a revoked device signing a valid new entry** — refused once the epoch has
   advanced, and the reason the epoch exists;
7. **a truncated chain served to a client with no pin**, i.e. one restored from
   the mnemonic — refused, or escalated to the mandatory device review.

Cases 6 and 7 were added by review and are the two that were actually load-
bearing; the first five test defences that already worked.

**Client.** `npm run build` first — `cliPairing` and `connectAgent` skip without
it (`CLAUDE.md`). Then `npm test`. New: `tests/addyTrustBoundary.test.ts` (pins
the T2 allowlist against `AppSettings` **and** the collection list against
`Persisted`), `tests/addyRoster.test.ts` (the same five adversarial cases,
client-side), `tests/addyIdentity.test.ts` (device ids are pseudonymous — no `os`
import, no two calls alike), `tests/addySchemaSkew.test.ts` (an older client must
go read-only rather than drop a field it does not know),
`tests/addyOffline.test.ts` (boot with the addy host black-holed; startup is
normal and no panel is disabled), `tests/addyRevokeWipe.test.ts`,
`tests/addyTarget.test.ts`, `tests/addydProtocol.test.ts` (Go/TS error-code union
parity).

**Docs.** New rows in the `SECURITY.md:52` storage table for the device keys and
the account key; a `THREAT_MODEL.md` in the addy repo stating plainly what a full
server compromise does and does not yield; and `docs/plans/addy-client.md` in
this repo for the client half, following the existing convention
(`docs/plans/vpn-tunnel-clients.md`, `cicd-module.md`) — those are the documents
that carry the reasoning this plan file is too short to hold.

**Manual.** Pair two machines, copy on one and paste on the other, send a file,
revoke a device from the first and confirm the second goes dark, then recover a
third from the mnemonic alone.

---

## What this deliberately does not do

Stated here so the README never implies otherwise, and so nobody discovers these
as bugs.

- **Ambient clipboard mirroring.** v1 is explicit send/receive on a keystroke.
  Wayland has no universal clipboard-read path, and — the finding that settles
  it — **macOS is actively closing this door**. macOS 15.4 added
  `NSPasteboard.accessBehavior`, whose documented default for the general
  pasteboard is to *prompt the user on programmatic access*, exempting only
  access that is "user originated and paste related". It currently ships behind a
  developer-preview default rather than enforced, but the direction of travel is
  unambiguous and an ambient poller is precisely the shape of thing it targets.
  There is not even an Info.plist key to explain your reason in the alert.

  An explicit send is *user originated and paste related*; a background poller is
  not. So the lazy option and the strategically safe option are the same one.

  **On GNOME Wayland ambient capture is not a gap, it is a refusal.** Mutter's
  maintainers closed the request as intentional — clipboard interception "is
  intentionally not permitted (since the clipboard often contains sensitive
  data)" — and every escape hatch has since closed: GNOME 49 disabled the X11
  session at compile time and GNOME 50 removed it, and there is no
  clipboard-manager portal (`org.freedesktop.portal.Clipboard` only extends
  RemoteDesktop/InputCapture sessions). The successor protocol
  `ext-data-control-v1` is supported by KWin, Sway, Hyprland, niri, COSMIC,
  labwc, Mir and others — but *not* Mutter, Muffin, Weston, river or Wayfire.
  Shipping ambient sync would therefore mean shipping a feature that is broken
  by design on the most common Linux desktop, forever. Explicit send works
  everywhere, because a paste is a user action.

  See "Clipboard capture, when we build it" below for the rules that apply
  whichever mode we ship.
- **Screenshot capture.** Transport is free once files work; the capture
  permission is the whole problem. Send-an-existing-file works in M4; a capture
  hotkey does not.
- **Live tab, pane and working-directory state.** `tabs`, `panes`,
  `activeTabId`, `tabCwd` are in `NOT_SYNCED` on purpose — two open apps sharing
  live tab state is a conflict machine. So "context loss" from the ick list is
  **not** addressed, and the docs must not imply it is.
- **SSH key material that lives in `~/.ssh`.** Syncing `servers` syncs *which*
  key a host uses, not the key — the record holds a `SecretBlob` with a
  `vaultEntryId` or a path (`src/main/services/credentialResolver.ts:11-31`). A
  key whose PEM the user put **in the vault** (`VaultEntry.privateKey`,
  `src/shared/vault.ts:60-68`) travels; a key referenced by path does not. Users
  will assume otherwise, so the UI says which of the two each server is using.
  Making `~/.ssh` sync is a separate, deliberate decision with its own blast
  radius — not something to do by accident.
- **Environment drift, app-setup fatigue, dev-environment recreation, login and
  browser fragmentation, network setup, hot spare.** Different products. The M6
  hedge keeps the door open; the claims stay out of the README until something
  ships.

Two more that are **not** acceptable to defer and are therefore designed in:

- **Cross-OS path breakage.** Identity-file paths, working directories and
  `.env` line endings diverge the instant a Mac and a Windows box pair — this is
  the first bug that will be filed. Any record holding a path gets per-device
  overrides and a visible "path missing on this device" state, rather than
  surfacing as a confusing connection failure.
- **Transferred-file residue.** A p2p transfer with no destination rule, no TTL
  and no shred *creates* the "sensitive file residue" ick the feature exists to
  fix. Transfers land in a known quarantine directory, carry a TTL, and are
  swept — same discipline as `inspect-capture/` (`SECURITY.md:79`), which is in
  the security table precisely because it once did not.

### Clipboard capture, when we build it

Research findings recorded now so they are not rediscovered later. These apply
to explicit send as much as to any ambient mode.

**Honouring do-not-sync markers is mandatory, not a nicety.** "Sensitive
clipboard exposure" is on the user's own pain list, and syncing a copied password
to three machines would be a self-inflicted version of the exact problem this
product exists to solve. Password managers already signal intent and we check
every one of these before a clipboard payload leaves the machine:

| Platform | Marker | Meaning |
|---|---|---|
| macOS | `org.nspasteboard.ConcealedType` | Confidential — never sync |
| macOS | `org.nspasteboard.TransientType` | Transient (payload is empty data) |
| macOS | `org.nspasteboard.AutoGeneratedType` | Machine-generated |
| Windows | `ExcludeClipboardContentFromMonitorProcessing` | Excludes history **and** sync |
| Windows | `CanUploadToCloudClipboard` = `DWORD 0` | **No device sync — this one is literally us** |
| Windows | `CanIncludeInClipboardHistory` = `DWORD 0` | No history |
| Windows | `Clipboard Viewer Ignore` | Legacy, cheap to honour |
| KDE/Linux | `x-kde-passwordManagerHint` = `secret` | Password-manager content |

The Windows formats are registered via `RegisterClipboardFormat`.

**Capture lives in the Go sidecar, not in Electron.** Electron has no clipboard
change event at all (`electron#2280`, open since 2015), cannot read file
references, and its raw buffer API is the only way to reach the markers above.
The sidecar is a separate process, which also sidesteps the macOS threading
hazard.

**Content identity: port SyncClipboard's hash spec, fixing two defects.** It is
SHA-256 throughout, UTF-8, uppercase hex: text hashes the *full* text rather than
the stored preview; a file hashes `"{fileName}|" + SHA256(content)` using the
filename only, so a rename changes identity and a move does not; and a multi-file
group hashes every file *and directory* recursively, entries sorted by the UTF-8
bytes of their relative name, each rendered as `D|{name}\0` or
`F|{name}|{length}|{hash}\0`.

It is worth porting because one content-addressed identity does five jobs at
once: dedup, echo detection, cache lookup (a remote payload already in local
history is resolved by hash and never downloaded at all), integrity checking, and
third-party compatibility. The construction details are deliberate — the `\0`
terminator makes concatenation unambiguous, the `{length}` catches truncation
that a content hash would only catch after a full read, and including directory
entries makes structure and empty folders part of identity.

Two defects to fix *while* porting, neither of which either project handles:

- **Normalise filenames to NFC before hashing.** macOS hands out NFD while
  Windows and Linux use NFC, so the same folder hashes differently per platform —
  which silently defeats the dedup this hash exists to provide, on precisely the
  cross-OS pairing the product is for.
- **Define size in bytes and truncate on a code-point boundary.** Theirs counts
  UTF-16 code units while documenting bytes, and can split a surrogate pair.

**Echo and loop breaking, which is harder than it looks.** A hash plus a
suppression window is the standard approach, and it has a trap that bites us
specifically: **Electron and Chrome re-normalise HTML when writing to the
clipboard**, so the content we write back does not hash to what we sent, and
naive hash-based echo detection fails. The working recipe is a short quiet window
plus an *armed* write-suppression flag set immediately before every self-write.
On the relay side, exclude the origin peer **and any peer sharing the origin's
host address** — two network interfaces on one machine otherwise looks like two
devices and loops.

**One user action can produce several clipboard writes.** Windows Snipping Tool
and Win+Shift+S write more than once for a single capture, and hash dedup does
*not* catch it because DPI metadata differs between the writes. The fix is a
~100 ms quiet window escalating to ~500 ms, re-validating the sequence number
after taking the snapshot and discarding on mismatch. Related: if the clipboard
changes *during* a read, discard the snapshot rather than sending a torn one.

**Two devices copying at once is unsolved in both projects** — both do
last-writer-wins, and SyncClipboard even built `If-Match`/ETag support and then
used it only for a hash backfill. We already have conditional PUT with ETags in
the object API, so we should actually use it here rather than inherit their
shrug.

**Line endings are handled by neither.** CRLF versus LF across a Windows/Unix
pair is an obvious corruption vector for exactly the content our users copy —
`.env` fragments, shell snippets, config blocks — and it was already flagged as a
cross-OS trap elsewhere in this plan. Normalise on the wire, restore per
platform, and never touch content inside a fenced or binary payload.

Per-platform traps, each of which is a real bug someone has shipped:

- **X11: never sync `PRIMARY`.** `CLIPBOARD` is Ctrl-C; `PRIMARY` is *every text
  highlight*, so syncing it would broadcast everything the user selects with a
  mouse. Also, X11 has no buffer — the owning app serves the bytes, so content
  vanishes when that app exits, and payloads over ~256KB need INCR chunking that
  many applications implement incorrectly on the send side.
- **Windows: `OpenClipboard` is a global exclusive lock and it is deniable.** The
  update message broadcasts to every listener on the same tick, so all clipboard
  tools on the machine race; losers get `ERROR_ACCESS_DENIED`, which is
  indistinguishable from an empty clipboard unless the code checks. So: key the
  cache on the lock-free `GetClipboardSequenceNumber()` rather than on message
  arrival, probe with `IsClipboardFormatAvailable` first, and retry *across*
  calls (~100 ms × 10) rather than spinning inside one. Delay-rendered formats
  additionally have a 30-second render timeout, so a large read can return null
  for reasons entirely outside our control.
- **macOS: poll `changeCount`**, on the main thread or out of process, and use
  the `detect`-family APIs to see *what kinds* of data are present without
  reading them — which both avoids the privacy prompt and avoids paying to read
  a payload we are going to reject on a marker anyway.
- **HTML is not plain text on any platform.** Windows `CF_HTML` carries a header
  with byte offsets that must be stripped on read and rebuilt on write; on Linux,
  reading HTML through a toolkit that only exposes UTF-16 produces mojibake, so
  the raw `text/html` target has to be read off the selection with charset
  detection. And a clipboard entry usually has *several* representations — pick
  deliberately, carry the ones that matter, and never assume the first is best.
- **X11 needs broad target coverage** to interoperate with real applications:
  `UTF8_STRING`, `COMPOUND_TEXT`, `TEXT`, `text/plain;charset=utf-8`,
  `text/uri-list`, `x-special/gnome-copied-files` and
  `application/x-kde-cutselection` at minimum.

One deferred-but-named: **borrowed / ephemeral devices.** The revoke primitive
already exists, so a time-boxed pairing is close by — but today pairing has
exactly one mode, "permanent", and that is worth saying out loud rather than
letting people assume a loaner is safe.

---

## Where this plan's conclusions came from

Most of the non-obvious decisions above are corrections, not first drafts. Recorded
so the reasoning is auditable and so nobody re-opens a settled question:

- **Adversarial review of the threat model** broke the original headline claim in
  four ways — the backup destination, the non-rotatable account key, unsigned
  signalling, and the Docker socket. The claim in the Context section is the
  rewritten one.
- **Library verification against upstream** killed MinIO (archived), magic-wormhole
  (no embeddable rendezvous), `tyler-smith/go-bip39` (repo deleted), and moved
  TURN from a coturn container to embedded pion.
- **A Bitwarden/Vaultwarden evaluation** rejected adoption on three independent
  grounds and then harvested the designs worth copying anyway — Send, rotation
  completeness validation, pointer-notifications, the invite-row trick, the admin
  boundary.
- **A continuity survey** found `tailcat`, produced the transport seam, and
  settled roster-versus-node-key identity.
- **Clipboard research** produced the do-not-sync marker table, the GNOME Wayland
  refusal, and the edge-case catalogue — and independently confirmed the
  explicit-send decision via macOS `NSPasteboard.accessBehavior`.

Two licence facts do most of the work and should be stated wherever someone might
forget them: **OpsMaxx is MIT with a CI test forbidding GPL/AGPL/LGPL/SSPL
anywhere in the tree**, and **reimplementing a documented protocol is not a
derivative work**. Every "borrow" above is a design borrowed from published prose
or a permissively-licensed port, never a copied implementation.

---

## Repo

`https://github.com/OpsMaxx/addy`, new and separate. Not a directory in this
repo: it has a different language, release cadence and audience. Note
`tests/branding.test.ts` here bans the retired product name in any tracked file —
addy inherits the same rule from day one so the check never needs an exemption.
