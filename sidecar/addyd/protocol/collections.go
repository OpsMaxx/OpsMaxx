package protocol

import (
	"fmt"
	"slices"
	"strings"
)

// The collections addy syncs, and the ones it deliberately does not.
//
// THIS LIST IS THE CONTRACT BETWEEN TWO IMPLEMENTATIONS. The OpsMaxx client
// decides what to put in each collection; addy decides nothing about their
// contents and cannot read them. What both sides must agree on is the NAMES,
// because a name appears in every object's AAD -- so a client writing `servers`
// and a client reading `Servers` are two clients that cannot sync.
//
// DEFAULT-DENY, ENFORCED BY A TEST. A new record type is either in Synced or in
// NotSynced with a written reason. Without that, the next feature that adds a
// record simply does not sync, and ABSENCE IS INDISTINGUISHABLE FROM "I HAVEN'T
// ADDED ONE YET" -- a silent failure with no error and no symptom until somebody
// notices their database connections never reached the second laptop.

// Synced is every T0 collection.
var Synced = []string{
	"apiCollections",
	"apiWorkspace",
	"cicdConnections",
	"databases",
	// deviceNames carries what the user actually CALLS each device, keyed on
	// its pub_sign.
	//
	// It exists because the roster's label_ct is a BIRTH NAME: entries are
	// immutable and renames are local, so a user who renamed quiet-otter-41 to
	// "work laptop" two years ago would see the pseudonym on the one screen
	// where recognition matters. Worse, the generator does not attempt
	// uniqueness and prescribes renaming as the fix for collisions -- which
	// only happen at scale -- so the user most likely to have renamed is the
	// user with the most devices, and the one for whom re-pairing a machine at
	// another site is most expensive.
	//
	// As a collection rather than a roster op it costs NO PROTOCOL CHANGE, and
	// the epoch problem solves itself: rotation already re-seals every T0
	// collection, which is exactly what an immutable chain entry cannot do.
	"deviceNames",
	"env",
	"folders",
	"httpChecks",
	"knownHosts",
	"manifest",
	"monitorGroups",
	"servers",
	"tunnels",
	// The vault travels as opaque bytes -- opsmaxx-vault.json verbatim, already
	// ciphertext under the user's master password. Nothing in the sync path
	// ever opens it, which is what makes the lock state irrelevant to sync and
	// stops the mnemonic being a skeleton key for it.
	"vault",
	"vpns",
	"workspaces",
}

// NotSynced is every key that is deliberately device-local, with the reason.
//
// A REASON IS MANDATORY. "We didn't get to it" and "this must never sync" look
// identical in a list of names, and only one of them is a decision.
var NotSynced = map[string]string{
	"tabs":              "per-device window state; syncing it would fight the user on two screens",
	"panes":             "per-device window state; syncing it would fight the user on two screens",
	"activeTabId":       "per-device window state; syncing it would fight the user on two screens",
	"activeWorkspaceId": "per-device window state; syncing it would fight the user on two screens",
	"tabCwd":            "per-device window state; syncing it would fight the user on two screens",
	"settings":          "the cosmetic subset is the T2 public profile; the rest is per-device",
	"theme":             "carried in the T2 public profile so a new device looks right before pairing",
	"version":           "a local on-disk seed marker, not user data",

	// THE ENTRIES BELOW ARE THE FINDING, not the list.
	//
	// A review of the trust-boundary guardrail found it pinned only against the
	// client's `Persisted` shape -- while the enumeration of what the app
	// actually writes to disk is much longer. Every file that is not a
	// `Persisted` key therefore fell outside the guardrail entirely: neither
	// synced nor recorded here, which is the exact failure the design warns
	// about, applied to whole FILES instead of record types.
	//
	// Device-local may well be right for an audit log. Nothing was forcing that
	// decision to be made or written down, and now something is.
	"runbooks":       "UNDECIDED: user-authored notes about their own estate, unreproducible, and currently lost on a device wipe. Wants a decision before M3",
	"rules":          "UNDECIDED: automation rules with pinned server ids. Same shape as runbooks",
	"processes":      "UNDECIDED: managed long-running process definitions",
	"backupTargets":  "UNDECIDED: where backups go; holds no credential but maps where the estate's copies live",
	"credproxyRules": "UNDECIDED: which third-party endpoints this machine forwards to",
	"envSecrets":     "UNDECIDED: which environment variables were registered as secret-bearing",
	"mcpConfig":      "device-local: names the loopback port and this install's own bridge entry",
	"aiPolicy":       "device-local: an access-control decision that must not be settable from a synced object",
	"history":        "device-local: an append-only command log. Syncing it would put every command run anywhere on every machine",
	"localSessions":  "device-local: an append-only log of local shells, their paths and working directories",
	"jobApprovals":   "device-local: an append-only record of who approved what",
	"credproxyAudit": "device-local: an append-only record of every credential forwarded and to whom",
	"aiAudit":        "device-local: an append-only record of every AI action",
	"inspectCA":      "device-local: a certificate authority installed into THIS machine's OS trust store. Syncing it would install one machine's interception CA on every other",
	"rdpCerts":       "device-local: trusted RDP host certificates, the same shape as known hosts but per-machine",
	"vaultBio":       "device-local: a biometric enrolment bound to this machine's secure enclave",
	"vpnState":       "device-local: engine key material, including a tsnet node identity that IS this device on the tailnet",
	"externalEdit":   "device-local: scratch copies of remote files opened in the user's own editor",
	"instanceId":     "device-local: deliberately excluded from wipe, and reused nowhere here -- see the pseudonym rule",
}

// CheckCollectionName rejects a name no implementation should be writing.
//
// The name is in every object's AAD, so a name that differs by case or spacing
// between two clients is two clients that cannot read each other's objects --
// and the failure is an AEAD error rather than anything that says why.
func CheckCollectionName(name string) error {
	if name == "" {
		return fmt.Errorf("protocol: an empty collection name")
	}
	if name != strings.TrimSpace(name) {
		return fmt.Errorf("protocol: collection %q has surrounding whitespace", name)
	}
	if !slices.Contains(Synced, name) {
		if reason, known := NotSynced[name]; known {
			return fmt.Errorf("protocol: %q is deliberately not synced: %s", name, reason)
		}
		return fmt.Errorf("protocol: %q is in neither the synced list nor the not-synced list; classify it", name)
	}
	return nil
}
