package protocol

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"testing"
)

// A deliberately malicious server harness.
//
// THIS IS THE TEST THAT MATTERS MOST. Every other property in the system rests
// on a client refusing a chain it should refuse, and each case below is a real
// move a server that owns the chain can make. Cases 6 and 7 are the load-bearing
// ones: the first five test defences that already worked in the original design,
// while a revoked device signing a new entry and a truncated chain served to a
// client with no pin are the two that were actually missing.

// builder constructs valid chains so the tests can then break them in one
// specific way each. Building them by hand would mean every test also tested the
// builder.
type builder struct {
	t       *testing.T
	acct    AccountID
	root    ed25519.PrivateKey
	epochs  map[uint64]ed25519.PrivateKey
	entries []Entry
	epoch   uint64
}

func newBuilder(t *testing.T) *builder { return newBuilderSeeded(t, 0x11) }

// newBuilderSeeded gives a DIFFERENT account. A fixed seed is right for a test
// that wants determinism and wrong for one comparing two accounts -- the first
// version of the card test built "two accounts" from one seed and was asserting
// nothing.
func newBuilderSeeded(t *testing.T, seed byte) *builder {
	t.Helper()
	root, err := DeriveRoot(bytes.Repeat([]byte{seed}, 64))
	if err != nil {
		t.Fatal(err)
	}
	ak1, err := DeriveEpoch(bytes.Repeat([]byte{seed ^ 0x30}, 32), root.AccountID, 1)
	if err != nil {
		t.Fatal(err)
	}
	return &builder{
		t:      t,
		acct:   root.AccountID,
		root:   root.Sign,
		epochs: map[uint64]ed25519.PrivateKey{1: ak1.Sign},
		epoch:  1,
	}
}

func (b *builder) rootPub() ed25519.PublicKey { return b.root.Public().(ed25519.PublicKey) }
func (b *builder) epoch1Pub() ed25519.PublicKey {
	return b.epochs[1].Public().(ed25519.PublicKey)
}

// device returns a deterministic device keypair, so a test can refer to "device
// 2" twice and mean the same thing.
func device(n byte) (pubSign, pubEnc []byte) {
	sign := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{n}, ed25519.SeedSize))
	enc := bytes.Repeat([]byte{n ^ 0xff}, 32)
	return sign.Public().(ed25519.PublicKey), enc
}

func (b *builder) prevHash() []byte {
	b.t.Helper()
	if len(b.entries) == 0 {
		return make([]byte, 32)
	}
	h, err := b.entries[len(b.entries)-1].Hash()
	if err != nil {
		b.t.Fatal(err)
	}
	return h
}

// append signs and appends an entry with whatever key its signer field names.
func (b *builder) append(e Entry) Entry {
	b.t.Helper()
	e.AccountID = b.acct
	e.Seq = uint64(len(b.entries))
	e.PrevHash = b.prevHash()
	if e.Nonce == nil {
		e.Nonce = bytes.Repeat([]byte{byte(e.Seq) + 1}, 32)
	}
	if e.PubEnc == nil {
		e.PubEnc = make([]byte, 32)
	}

	var key ed25519.PrivateKey
	switch e.Signer {
	case SignerRK:
		key = b.root
	case SignerAK:
		want := e.Epoch
		if e.Op == OpEpoch {
			want = e.Epoch - 1
		}
		key = b.epochs[want]
		if key == nil {
			b.t.Fatalf("no key for epoch %d", want)
		}
	}

	body, err := e.Encode()
	if err != nil {
		b.t.Fatal(err)
	}
	e.Sig = ed25519.Sign(key, body)
	b.entries = append(b.entries, e)
	return e
}

func (b *builder) addDevice(n byte) Entry {
	b.t.Helper()
	pubSign, pubEnc := device(n)
	return b.append(Entry{
		Epoch: b.epoch, Op: OpAdd, Signer: SignerAK,
		PubSign: pubSign, PubEnc: pubEnc,
		LabelCT: bytes.Repeat([]byte{n}, 40), TS: 1,
	})
}

func (b *builder) revokeDevice(n byte) Entry {
	b.t.Helper()
	pubSign, pubEnc := device(n)
	return b.append(Entry{
		Epoch: b.epoch, Op: OpRevoke, Signer: SignerAK,
		PubSign: pubSign, PubEnc: pubEnc, TS: 1,
	})
}

// rotate advances the epoch. A revocation rotation must be root-signed; a
// hygiene rotation may be signed by the previous epoch's key.
func (b *builder) rotate(revocation bool) Entry {
	b.t.Helper()
	next := b.epoch + 1
	ak, err := DeriveEpoch(bytes.Repeat([]byte{0x20 + byte(next)}, 32), b.acct, next)
	if err != nil {
		b.t.Fatal(err)
	}
	b.epochs[next] = ak.Sign

	signer := SignerAK
	var flags uint8
	if revocation {
		signer = SignerRK
		flags = FlagRevocationRotation
	}
	e := b.append(Entry{
		Epoch: next, Op: OpEpoch, Signer: signer, Flags: flags,
		PubSign: ak.Sign.Public().(ed25519.PublicKey),
		PubEnc:  ak.Enc.PublicKey().Bytes(),
		TS:      1,
	})
	b.epoch = next
	return e
}

func (b *builder) raw() []byte {
	b.t.Helper()
	var out []byte
	for _, e := range b.entries {
		w, err := e.Wire()
		if err != nil {
			b.t.Fatal(err)
		}
		out = append(out, w...)
	}
	return out
}

func (b *builder) verify(raw []byte, pin *Pin) (*Verified, error) {
	return VerifyChain(raw, b.acct, b.rootPub(), b.epoch1Pub(), pin)
}

// The happy path, so every refusal below cannot pass by refusing everything --
// which is how a security check most often breaks.
func TestAHonestChainVerifies(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)
	b.addDevice(2)
	b.revokeDevice(1)

	v, err := b.verify(b.raw(), nil)
	if err != nil {
		t.Fatalf("an honest chain was refused: %v", err)
	}
	if len(v.Devices) != 1 {
		t.Fatalf("device set has %d entries, want 1", len(v.Devices))
	}
	pub2, _ := device(2)
	if !bytes.Equal(v.Devices[0].PubSign, pub2) {
		t.Error("the surviving device is not the one that was not revoked")
	}
	if v.Epoch != 1 || v.Entries != 3 {
		t.Errorf("epoch=%d entries=%d", v.Epoch, v.Entries)
	}
}

// CASE 1: an entry the epoch key did not sign.
func TestCase1AnEntrySignedByTheWrongKeyIsRefused(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)
	b.addDevice(2)

	// Re-sign the last entry with a key that is not the account's.
	stranger := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x99}, ed25519.SeedSize))
	last := &b.entries[len(b.entries)-1]
	body, err := last.Encode()
	if err != nil {
		t.Fatal(err)
	}
	last.Sig = ed25519.Sign(stranger, body)

	if _, err := b.verify(b.raw(), nil); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("verify = %v, want ErrBadSignature", err)
	}
}

// CASE 2: a chain whose prev_hash does not link.
func TestCase2ABrokenLinkIsRefused(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)
	b.addDevice(2)
	b.addDevice(3)

	// Break the link and re-sign, so the signature is valid and only the link
	// is wrong -- otherwise this would be case 1 again.
	e := &b.entries[2]
	e.PrevHash = bytes.Repeat([]byte{0xaa}, 32)
	body, err := e.Encode()
	if err != nil {
		t.Fatal(err)
	}
	e.Sig = ed25519.Sign(b.epochs[1], body)

	if _, err := b.verify(b.raw(), nil); !errors.Is(err, ErrBrokenLink) {
		t.Fatalf("verify = %v, want ErrBrokenLink", err)
	}
}

// CASE 3: a chain rewound below the seq this client has already seen.
func TestCase3ARewoundChainIsRefused(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)
	b.addDevice(2)
	b.revokeDevice(1)

	full := b.raw()
	v, err := b.verify(full, nil)
	if err != nil {
		t.Fatal(err)
	}
	pin := &Pin{Seq: v.HeadSeq, Hash: v.Head}

	// The server now serves the chain from before the revocation.
	b.entries = b.entries[:2]
	if _, err := b.verify(b.raw(), pin); !errors.Is(err, ErrRewound) {
		t.Fatalf("verify = %v, want ErrRewound", err)
	}
}

// CASE 4: a real device's entry with a substituted encryption key.
func TestCase4ASubstitutedEncryptionKeyIsRefused(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)
	b.addDevice(2)

	// A revoke naming device 1 but a different pub_enc: a way to rewrite a
	// live device's encryption key if it were accepted.
	pubSign, _ := device(1)
	b.append(Entry{
		Epoch: 1, Op: OpRevoke, Signer: SignerAK,
		PubSign: pubSign, PubEnc: bytes.Repeat([]byte{0x77}, 32), TS: 1,
	})

	if _, err := b.verify(b.raw(), nil); !errors.Is(err, ErrBadOp) {
		t.Fatalf("verify = %v, want ErrBadOp", err)
	}
}

// CASE 6, LOAD-BEARING: a revoked device signing a valid new entry, refused
// once the epoch has advanced.
//
// This is the reason the epoch exists. A device revoked in epoch n still HOLDS
// AK_n and can produce entries that verify under it -- which is why revoking a
// possibly-hostile device is always accompanied by a rotation.
func TestCase6ARevokedDeviceCannotAuthorAfterTheEpochAdvances(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)
	b.addDevice(2)
	b.revokeDevice(1)
	b.rotate(true) // revocation rotation, root-signed

	honest := b.raw()
	if _, err := b.verify(honest, nil); err != nil {
		t.Fatalf("the honest chain through a rotation was refused: %v", err)
	}

	// The revoked device still holds AK_1 and authors an entry re-admitting
	// itself, correctly signed under epoch 1's key.
	pubSign, pubEnc := device(1)
	b.append(Entry{
		Epoch: 1, Op: OpAdd, Signer: SignerAK,
		PubSign: pubSign, PubEnc: pubEnc,
		LabelCT: bytes.Repeat([]byte{1}, 40), TS: 1,
	})

	_, err := b.verify(b.raw(), nil)
	if err == nil {
		t.Fatal("a revoked device re-admitted itself with the epoch key it still holds")
	}
	// It fails epoch monotonicity: the chain has moved to epoch 2 and this
	// entry claims epoch 1.
	if !errors.Is(err, ErrBadEpoch) {
		t.Fatalf("verify = %v, want ErrBadEpoch", err)
	}
}

// The other half of case 6: the same device claiming the NEW epoch, still
// signing with the old key it holds.
func TestCase6bTheOldEpochKeyCannotSignForTheNewEpoch(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)
	b.revokeDevice(1)
	b.rotate(true)

	pubSign, pubEnc := device(1)
	e := Entry{
		AccountID: b.acct, Epoch: 2, Seq: uint64(len(b.entries)),
		PrevHash: b.prevHash(), Op: OpAdd, Signer: SignerAK,
		Nonce:   bytes.Repeat([]byte{9}, 32),
		PubSign: pubSign, PubEnc: pubEnc,
		LabelCT: bytes.Repeat([]byte{1}, 40), TS: 1,
	}
	body, err := e.Encode()
	if err != nil {
		t.Fatal(err)
	}
	// Signed with epoch 1's key while claiming epoch 2.
	e.Sig = ed25519.Sign(b.epochs[1], body)
	b.entries = append(b.entries, e)

	if _, err := b.verify(b.raw(), nil); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("verify = %v, want ErrBadSignature", err)
	}
}

// A revocation rotation signed by the epoch key rather than the root key must be
// refused. If it were accepted, a compromised epoch key would authorise the
// escape from itself, which is the entire thing the split exists to prevent.
func TestARevocationRotationMustBeRootSigned(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)

	next := b.epoch + 1
	ak, err := DeriveEpoch(bytes.Repeat([]byte{0x2a}, 32), b.acct, next)
	if err != nil {
		t.Fatal(err)
	}
	b.epochs[next] = ak.Sign
	b.append(Entry{
		Epoch: next, Op: OpEpoch, Signer: SignerAK,
		Flags:   FlagRevocationRotation,
		PubSign: ak.Sign.Public().(ed25519.PublicKey),
		PubEnc:  ak.Enc.PublicKey().Bytes(), TS: 1,
	})

	if _, err := b.verify(b.raw(), nil); !errors.Is(err, ErrBadSigner) {
		t.Fatalf("verify = %v, want ErrBadSigner", err)
	}
}

// CASE 7, LOAD-BEARING: a truncated chain served to a client with NO pin --
// a device restored from the mnemonic alone.
//
// There is no cryptographic fix: the truncated chain is genuinely, validly
// signed. What the code can do is refuse to hide it, which is why a
// no-pin verification returns the device set for a mandatory human review
// rather than adopting it silently.
func TestCase7ATruncatedChainIsSignedAndValidWhichIsWhyAHumanMustSeeIt(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)
	b.addDevice(2)
	b.revokeDevice(1)

	full, err := b.verify(b.raw(), nil)
	if err != nil {
		t.Fatal(err)
	}

	// The server truncates to before the revocation.
	b.entries = b.entries[:2]
	truncated, err := b.verify(b.raw(), nil)
	if err != nil {
		t.Fatalf("the truncated chain did not verify, which would make this test prove nothing: %v", err)
	}

	// Both verify. That is the finding, not a bug: the defence cannot be
	// cryptographic.
	if len(truncated.Devices) <= len(full.Devices) {
		t.Fatal("the truncated chain did not actually restore the revoked device")
	}
	revoked, _ := device(1)
	if indexOfDevice(truncated.Devices, revoked) < 0 {
		t.Fatal("the revoked device is absent from the truncated chain, so this is not the attack")
	}

	// With a pin, the same truncation is caught outright.
	pin := &Pin{Seq: full.HeadSeq, Hash: full.Head}
	if _, err := b.verify(b.raw(), pin); !errors.Is(err, ErrRewound) {
		t.Fatalf("with a pin, verify = %v, want ErrRewound", err)
	}
}

// A fork at a sequence the client has already pinned, at the same length, so
// the rewind check does not catch it.
func TestAForkedChainAtAPinnedSeqIsRefused(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)
	b.addDevice(2)

	v, err := b.verify(b.raw(), nil)
	if err != nil {
		t.Fatal(err)
	}
	pin := &Pin{Seq: 1, Hash: mustEntryHash(t, b.entries[1])}
	_ = v

	// The server rebuilds the chain from seq 1 onward with a different device.
	b.entries = b.entries[:1]
	b.addDevice(3)
	b.addDevice(4)

	if _, err := b.verify(b.raw(), pin); !errors.Is(err, ErrForked) {
		t.Fatalf("verify = %v, want ErrForked", err)
	}
}

// Unknown flag bits are refused. An ignored bit is a covert channel and a
// compatibility trap at the same time.
func TestUnknownFlagBitsAreRefused(t *testing.T) {
	b := newBuilder(t)
	pubSign, pubEnc := device(1)
	b.append(Entry{
		Epoch: 1, Op: OpAdd, Signer: SignerAK, Flags: 0x80,
		PubSign: pubSign, PubEnc: pubEnc,
		LabelCT: bytes.Repeat([]byte{1}, 40), TS: 1,
	})
	if _, err := b.verify(b.raw(), nil); !errors.Is(err, ErrBadFlags) {
		t.Fatalf("verify = %v, want ErrBadFlags", err)
	}
}

// A label on a revoke or a transition is a covert channel in bytes the server
// stores verbatim.
func TestALabelOnARevokeOrTransitionIsRefused(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)
	pubSign, pubEnc := device(1)
	b.append(Entry{
		Epoch: 1, Op: OpRevoke, Signer: SignerAK,
		PubSign: pubSign, PubEnc: pubEnc,
		LabelCT: []byte("smuggled"), TS: 1,
	})
	if _, err := b.verify(b.raw(), nil); !errors.Is(err, ErrBadOp) {
		t.Fatalf("verify = %v, want ErrBadOp", err)
	}
}

// A genesis that is a revoke or a transition describes an account that never
// existed.
func TestAGenesisThatIsNotAnAddIsRefused(t *testing.T) {
	b := newBuilder(t)
	pubSign, pubEnc := device(1)
	b.append(Entry{
		Epoch: 1, Op: OpRevoke, Signer: SignerAK,
		PubSign: pubSign, PubEnc: pubEnc, TS: 1,
	})
	if _, err := b.verify(b.raw(), nil); !errors.Is(err, ErrBadGenesis) {
		t.Fatalf("verify = %v, want ErrBadGenesis", err)
	}
}

// A chain that is internally consistent but belongs to somebody else.
func TestAChainForAnotherAccountIsRefused(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)

	var other AccountID
	other[0] = 0xff
	if _, err := VerifyChain(b.raw(), other, b.rootPub(), b.epoch1Pub(), nil); !errors.Is(err, ErrWrongAccount) {
		t.Fatalf("verify = %v, want ErrWrongAccount", err)
	}
}

// Trailing bytes after the last entry must not be tolerated: it is the cheapest
// way to append something to a chain half the fleet will see.
func TestTrailingBytesAfterTheLastEntryAreRefused(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)
	raw := append(b.raw(), 0x00, 0x01, 0x02)
	if _, err := b.verify(raw, nil); err == nil {
		t.Fatal("a chain with trailing bytes was accepted")
	}
}

func TestAnEmptyChainIsRefused(t *testing.T) {
	b := newBuilder(t)
	if _, err := b.verify(nil, nil); !errors.Is(err, ErrEmptyChain) {
		t.Fatalf("verify = %v, want ErrEmptyChain", err)
	}
}

// An add signed by the root key is mnemonic-authored whether or not the flag is
// set, because the root key only exists where the phrase was typed.
func TestARootSignedAddIsTreatedAsMnemonicAuthored(t *testing.T) {
	b := newBuilder(t)
	pubSign, pubEnc := device(1)
	b.append(Entry{
		Epoch: 1, Op: OpAdd, Signer: SignerRK,
		PubSign: pubSign, PubEnc: pubEnc,
		LabelCT: bytes.Repeat([]byte{1}, 40), TS: 1,
	})

	v, err := b.verify(b.raw(), nil)
	if err != nil {
		t.Fatalf("a root-signed genesis add was refused: %v", err)
	}
	if !v.Devices[0].MnemonicAuthored() {
		t.Error("a root-signed add was not treated as mnemonic-authored")
	}
}

func mustEntryHash(t *testing.T, e Entry) []byte {
	t.Helper()
	h, err := e.Hash()
	if err != nil {
		t.Fatal(err)
	}
	return h
}

// The shape a RECOVERY produces, pinned deliberately rather than by omission.
//
// §5.8 forces a hard re-key on recovery, and the review of the review-screen
// design settled what that tail looks like: revoke every device the user did
// not re-confirm, transition to the next epoch, then add the recovering device.
// In the worst case -- the user confirms nothing -- the chain passes through a
// ZERO-DEVICE SET between the last revoke and the self-add.
//
// That is legal: there is no minimum-device-count invariant, only a refusal of
// a chain with no entries at all. It was legal by ACCIDENT though, which is the
// kind of property that gets broken by a well-meaning "a roster must always
// have at least one device" check. So it is asserted.
func TestARecoveryChainMayPassThroughZeroDevices(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)
	b.addDevice(2)

	// The user confirms nothing, so both existing devices are revoked in the
	// epoch they were actually in.
	b.revokeDevice(1)
	b.revokeDevice(2)

	// Between here and the self-add, the device set is empty.
	mid, err := b.verify(b.raw(), nil)
	if err != nil {
		t.Fatalf("a chain with every device revoked was refused: %v", err)
	}
	if len(mid.Devices) != 0 {
		t.Fatalf("device set has %d entries, want 0", len(mid.Devices))
	}

	// A revocation rotation, root-signed, because a recovery is by definition
	// a moment when the user no longer knows which devices are theirs.
	b.rotate(true)

	// And the recovering device adds itself under the NEW epoch.
	pubSign, pubEnc := device(9)
	b.append(Entry{
		Epoch: b.epoch, Op: OpAdd, Signer: SignerAK,
		PubSign: pubSign, PubEnc: pubEnc,
		LabelCT: bytes.Repeat([]byte{9}, 40), TS: 1,
	})

	v, err := b.verify(b.raw(), nil)
	if err != nil {
		t.Fatalf("the recovery chain was refused: %v", err)
	}
	if len(v.Devices) != 1 {
		t.Fatalf("after recovery the device set has %d entries, want 1", len(v.Devices))
	}
	if !bytes.Equal(v.Devices[0].PubSign, pubSign) {
		t.Error("the surviving device is not the recovering one")
	}
	if v.Epoch != 2 {
		t.Errorf("chain ends in epoch %d, want 2", v.Epoch)
	}
}

// And the partial case, which is the normal one: some devices re-confirmed,
// some not. Confirmed devices are NEVER REVOKED -- they survive the rotation
// and pick up the new epoch key when they next wake -- so a sleeping laptop the
// user recognised is not punished for being asleep.
func TestARecoveryKeepsTheDevicesTheUserConfirmed(t *testing.T) {
	b := newBuilder(t)
	b.addDevice(1)
	b.addDevice(2)
	b.addDevice(3)

	// Device 2 is the one the user did not recognise.
	b.revokeDevice(2)
	b.rotate(true)

	pubSign, pubEnc := device(9)
	b.append(Entry{
		Epoch: b.epoch, Op: OpAdd, Signer: SignerAK,
		PubSign: pubSign, PubEnc: pubEnc,
		LabelCT: bytes.Repeat([]byte{9}, 40), TS: 1,
	})

	v, err := b.verify(b.raw(), nil)
	if err != nil {
		t.Fatalf("the recovery chain was refused: %v", err)
	}
	if len(v.Devices) != 3 {
		t.Fatalf("device set has %d entries, want 3 (two kept, one added)", len(v.Devices))
	}
	revoked, _ := device(2)
	if indexOfDevice(v.Devices, revoked) >= 0 {
		t.Error("the unconfirmed device survived the recovery")
	}
	for _, n := range []byte{1, 3} {
		kept, _ := device(n)
		if indexOfDevice(v.Devices, kept) < 0 {
			t.Errorf("device %d was confirmed but did not survive", n)
		}
	}
}
