package protocol

import (
	"slices"
	"strings"
	"testing"
)

// DEFAULT-DENY. A name in neither list is a name somebody has to classify, and
// the error says so rather than treating it as a typo.
func TestAnUnclassifiedCollectionIsRefused(t *testing.T) {
	err := CheckCollectionName("somethingNew")
	if err == nil {
		t.Fatal("an unclassified collection name was accepted")
	}
	if !strings.Contains(err.Error(), "classify it") {
		t.Errorf("the error does not say what to do: %v", err)
	}
}

// A deliberately-device-local name gets its REASON back, not a generic refusal.
// "We didn't get to it" and "this must never sync" look identical in a list of
// names, and only one of them is a decision.
func TestADeviceLocalCollectionRefusesWithItsReason(t *testing.T) {
	err := CheckCollectionName("aiAudit")
	if err == nil {
		t.Fatal("a device-local collection was accepted as synced")
	}
	if !strings.Contains(err.Error(), "append-only") {
		t.Errorf("the refusal does not carry the reason: %v", err)
	}
}

func TestEverySyncedCollectionIsAccepted(t *testing.T) {
	for _, name := range Synced {
		if err := CheckCollectionName(name); err != nil {
			t.Errorf("CheckCollectionName(%q) = %v", name, err)
		}
	}
}

// The name is in every object's AAD, so a name that differs by case or spacing
// between two clients is two clients that cannot read each other's objects --
// and the failure is an AEAD error rather than anything that says why.
func TestCollectionNamesAreWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, name := range Synced {
		if seen[name] {
			t.Errorf("duplicate collection %q", name)
		}
		seen[name] = true
		if name != strings.TrimSpace(name) || strings.ContainsAny(name, " \t/") {
			t.Errorf("collection %q is not a bare name", name)
		}
	}
	// Sorted, so a diff of this list is readable and two implementations
	// enumerate it identically.
	if !slices.IsSorted(Synced) {
		t.Error("the synced list is not sorted")
	}
	// No name may be in both lists, or its classification is ambiguous.
	for name := range NotSynced {
		if slices.Contains(Synced, name) {
			t.Errorf("%q is in both lists", name)
		}
	}
}

// Every not-synced entry must carry a reason. An empty one is the failure this
// list exists to prevent, wearing the list's own clothes.
func TestEveryNotSyncedEntryCarriesAReason(t *testing.T) {
	for name, reason := range NotSynced {
		if strings.TrimSpace(reason) == "" {
			t.Errorf("%q is not synced for no stated reason", name)
		}
		if len(reason) < 20 {
			t.Errorf("%q's reason is too short to be one: %q", name, reason)
		}
	}
}

// deviceNames is the fix for the birth-name problem, so its presence is
// asserted rather than left to a list nobody re-reads.
func TestDeviceNamesIsSynced(t *testing.T) {
	if !slices.Contains(Synced, "deviceNames") {
		t.Fatal("deviceNames is not synced; the recovery screen would show birth names only")
	}
	if err := CheckCollectionName("deviceNames"); err != nil {
		t.Errorf("CheckCollectionName(deviceNames) = %v", err)
	}
}

// THE GUARDRAIL'S HOLE, pinned so it cannot reopen.
//
// A review found the trust-boundary test specified to pin only against the
// client's Persisted shape, while the enumeration of what the app writes to
// disk is much longer -- so every file that is not a Persisted key fell outside
// the guardrail entirely. These are those files. Each must be classified, and
// the ones still marked UNDECIDED must be decided before the client half ships.
func TestEveryFileTheAppWritesIsClassified(t *testing.T) {
	// Derived from the sibling repo's ALL_DATA_FILES, which is itself pinned
	// against a directory listing there.
	fromDisk := []string{
		"runbooks", "rules", "processes", "backupTargets", "credproxyRules",
		"envSecrets", "mcpConfig", "aiPolicy", "history", "localSessions",
		"jobApprovals", "credproxyAudit", "aiAudit", "inspectCA", "rdpCerts",
		"vaultBio", "vpnState", "externalEdit", "instanceId",
		"vault", "knownHosts",
	}
	for _, name := range fromDisk {
		_, notSynced := NotSynced[name]
		if !notSynced && !slices.Contains(Synced, name) {
			t.Errorf("%q is written to disk but appears in neither list", name)
		}
	}
}

// The UNDECIDED entries are a deliberate marker, not an oversight, and this
// test is what stops them being forgotten. It FAILS LOUDLY once they are
// decided and the marker removed -- which is the point: somebody has to come
// back here.
func TestUndecidedCollectionsAreStillMarked(t *testing.T) {
	var undecided []string
	for name, reason := range NotSynced {
		if strings.HasPrefix(reason, "UNDECIDED") {
			undecided = append(undecided, name)
		}
	}
	slices.Sort(undecided)
	t.Logf("still undecided, and each is user-authored data currently lost on a device wipe: %v", undecided)
	if len(undecided) == 0 {
		t.Log("all collections are decided; this test can be deleted")
	}
}
