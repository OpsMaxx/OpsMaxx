package main

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/opsmaxx/opsmaxx/sidecar/addyd/protocol"
)

// The --crypto role's methods.
//
// THIS PROCESS HOLDS THE KEYS AND NEVER LINKS A WEBRTC STACK. The split is the
// whole reason addyd has two subcommands: a stack that parses untrusted SDP,
// STUN, DTLS and SRTP straight off the open internet should not be loaded in
// the address space that holds the account key, whether or not it is reached.
//
// The parent (Electron main) holds the SEALED key material -- it is the only
// party with a keychain -- and hands it over on `load`. This process holds the
// unsealed keys for as long as it runs and writes none of them anywhere.

// vault is the unsealed key material, for one account.
//
// A mutex rather than a channel-owned goroutine: the operations are short,
// there is no ordering requirement between them, and the parent serialises its
// own requests anyway. What the lock is actually for is `reset`, which can
// arrive while a seal is in flight.
type vault struct {
	mu sync.RWMutex

	loaded  bool
	account protocol.AccountID
	device  *protocol.DeviceKeys
	// epochs holds every epoch key this device has been given. More than one
	// at a time during a transition: objects re-sealed under n+1 land before
	// the signed transition entry does, so a client still reading n needs n.
	epochs map[uint64]*protocol.EpochKeys
	// rootSignPub is RK_sign's public half, needed to verify root-signed
	// roster entries. Public, so it is held here rather than in the keychain.
	rootSignPub []byte
}

var keys = &vault{epochs: map[uint64]*protocol.EpochKeys{}}

func (v *vault) reset() {
	v.mu.Lock()
	defer v.mu.Unlock()
	// Zeroed rather than dropped. Go will not promise the old bytes are gone,
	// but leaving them reachable when we have a reference is a choice, and
	// this is the one process on the machine whose whole job is holding them.
	for _, e := range v.epochs {
		// The profile key is ours to clear. The X25519 private key is held by
		// crypto/ecdh behind an interface with no zeroing method, which is a
		// limit of the standard library rather than a decision here -- worth
		// saying so rather than leaving a reader to wonder why one is wiped
		// and the other is not.
		zero(e.Profile)
	}
	v.epochs = map[uint64]*protocol.EpochKeys{}
	v.device = nil
	v.rootSignPub = nil
	v.loaded = false
	v.account = protocol.AccountID{}
}

func zero(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

func (v *vault) epoch(n uint64) (*protocol.EpochKeys, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	if !v.loaded {
		return nil, codedf(ErrNotPaired, "no account is loaded")
	}
	e, ok := v.epochs[n]
	if !ok {
		// Named rather than generic: a client asking for an epoch this device
		// does not hold is usually a client that missed a rotation, and the
		// remedy is to fetch the roster rather than to retry.
		return nil, codedf(ErrNotPaired, "this device holds no key for epoch %d", n)
	}
	return e, nil
}

// --- load ---

type loadRequest struct {
	// Hex of the 32-byte account id.
	AccountID string `json:"accountId"`
	// Base64 of the device's Ed25519 seed and of its X25519 private key.
	//
	// TWO INDEPENDENT KEYS, not one seed and a conversion. Birational maps
	// between Ed25519 and X25519 exist and are exactly the shortcut the
	// protocol package forbids: keys that share bytes make every
	// cross-protocol attack on the pair live in a system that otherwise has
	// none. The parent stores both.
	DeviceSignSeed string `json:"deviceSignSeed"`
	DeviceEncKey   string `json:"deviceEncKey"`
	// Epoch number -> base64 AK_n. Several at once during a transition.
	EpochKeys map[uint64]string `json:"epochKeys"`
	// Hex of RK_sign's public half.
	//
	// PUBLIC, and still required: a device cannot verify a root-signed roster
	// entry without it, and root-signed entries are exactly the ones that
	// authorise an epoch change. A device that did not hold it would have to
	// take the relay's word for which key signed a rotation, which is the one
	// thing the roster exists to make unnecessary.
	RootSignPub string `json:"rootSignPub"`
}

// handleLoad takes the key material from the parent.
//
// Nothing is persisted here. The parent's keychain is the store; this process
// is where the keys are USABLE, and it forgets everything when it exits --
// which is what makes killing the sidecar a real remediation rather than a
// gesture.
func handleLoad(req Request) (any, error) {
	var in loadRequest
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}

	raw, err := hex.DecodeString(in.AccountID)
	if err != nil || len(raw) != protocol.AccountIDLen {
		return nil, codedf(ErrConfigInvalid, "accountId is %d bytes of hex", protocol.AccountIDLen)
	}
	seed, err := base64.StdEncoding.DecodeString(in.DeviceSignSeed)
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, codedf(ErrConfigInvalid, "deviceSignSeed is %d bytes, base64", ed25519.SeedSize)
	}
	encRaw, err := base64.StdEncoding.DecodeString(in.DeviceEncKey)
	if err != nil || len(encRaw) != 32 {
		return nil, codedf(ErrConfigInvalid, "deviceEncKey is 32 bytes, base64")
	}
	if len(in.EpochKeys) == 0 {
		return nil, codedf(ErrNotPaired, "no epoch key was supplied; this device cannot read anything")
	}

	encKey, err := ecdh.X25519().NewPrivateKey(encRaw)
	if err != nil {
		return nil, wrapCoded(ErrConfigInvalid, err, "loading the device encryption key")
	}
	device := &protocol.DeviceKeys{
		Sign:     ed25519.NewKeyFromSeed(seed),
		SignSeed: seed,
		Enc:      encKey,
	}

	rootPub, err := hex.DecodeString(in.RootSignPub)
	if err != nil || len(rootPub) != ed25519.PublicKeySize {
		return nil, codedf(ErrConfigInvalid, "rootSignPub is %d bytes of hex", ed25519.PublicKeySize)
	}

	var acct protocol.AccountID
	copy(acct[:], raw)

	epochs := make(map[uint64]*protocol.EpochKeys, len(in.EpochKeys))
	for n, encoded := range in.EpochKeys {
		ak, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, codedf(ErrConfigInvalid, "the key for epoch %d is not base64", n)
		}
		e, err := protocol.DeriveEpoch(ak, acct, n)
		zero(ak)
		if err != nil {
			return nil, wrapCoded(ErrConfigInvalid, err, "deriving epoch %d", n)
		}
		epochs[n] = e
	}

	keys.mu.Lock()
	keys.account = acct
	keys.device = device
	keys.epochs = epochs
	keys.rootSignPub = rootPub
	keys.loaded = true
	keys.mu.Unlock()

	return map[string]any{
		"accountId": acct.String(),
		"devicePub": hex.EncodeToString(device.Sign.Public().(ed25519.PublicKey)),
		"epochs":    epochNumbers(epochs),
	}, nil
}

func epochNumbers(m map[uint64]*protocol.EpochKeys) []uint64 {
	out := make([]uint64, 0, len(m))
	for n := range m {
		out = append(out, n)
	}
	return out
}

// --- seal / open ---

type sealRequest struct {
	Collection    string `json:"collection"`
	Epoch         uint64 `json:"epoch"`
	Schema        uint32 `json:"schema"`
	WriterVersion string `json:"writerVersion"`
	Counter       uint64 `json:"counter"`
	// Base64 of the plaintext. The parent decides what a collection contains;
	// this process never parses it.
	Payload string `json:"payload"`
}

func handleSeal(req Request) (any, error) {
	var in sealRequest
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	e, err := keys.epoch(in.Epoch)
	if err != nil {
		return nil, err
	}
	payload, err := base64.StdEncoding.DecodeString(in.Payload)
	if err != nil {
		return nil, codedf(ErrConfigInvalid, "payload is not base64")
	}

	keys.mu.RLock()
	acct := keys.account
	keys.mu.RUnlock()

	sealed, err := protocol.SealCollection(protocol.Collection{
		Name:          in.Collection,
		Schema:        in.Schema,
		WriterVersion: in.WriterVersion,
		Counter:       in.Counter,
		Payload:       payload,
	}, acct, in.Epoch, e.Profile)
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "sealing %s", in.Collection)
	}
	return map[string]any{"sealed": base64.StdEncoding.EncodeToString(sealed)}, nil
}

type openRequest struct {
	Collection string `json:"collection"`
	Epoch      uint64 `json:"epoch"`
	Sealed     string `json:"sealed"`
	// What the reader can understand, and the highest counter it has already
	// seen for this collection. Both are anti-rollback controls and both are
	// enforced inside OpenCollection rather than by the caller.
	KnownSchema uint32 `json:"knownSchema"`
	SeenCounter uint64 `json:"seenCounter"`
}

func handleOpen(req Request) (any, error) {
	var in openRequest
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	e, err := keys.epoch(in.Epoch)
	if err != nil {
		return nil, err
	}
	sealed, err := base64.StdEncoding.DecodeString(in.Sealed)
	if err != nil {
		return nil, codedf(ErrConfigInvalid, "sealed is not base64")
	}

	keys.mu.RLock()
	acct := keys.account
	keys.mu.RUnlock()

	c, err := protocol.OpenCollection(sealed, in.Collection, acct, in.Epoch, e.Profile, in.KnownSchema, in.SeenCounter)
	if err != nil {
		// The three failures a caller must tell apart, because the remedies
		// differ: a schema it cannot read means go read-only for that
		// collection, a rewound counter means refuse and warn, and anything
		// else means the bytes are not what they claim.
		switch {
		case errors.Is(err, protocol.ErrSchemaTooNew):
			return nil, wrapCoded(ErrSchemaTooNew, err, "opening %s", in.Collection)
		case errors.Is(err, protocol.ErrObjectRollback):
			return nil, wrapCoded(ErrRosterRewound, err, "opening %s", in.Collection)
		default:
			return nil, wrapCoded(ErrRosterInvalid, err, "opening %s", in.Collection)
		}
	}

	return map[string]any{
		"collection":    c.Name,
		"schema":        c.Schema,
		"writerVersion": c.WriterVersion,
		"counter":       c.Counter,
		"payload":       base64.StdEncoding.EncodeToString(c.Payload),
	}, nil
}

// --- roster ---

type addDeviceRequest struct {
	// The chain head this entry follows, base64 of the wire entry, so its hash
	// and sequence come from the chain THIS device verified rather than from
	// anything the relay asserted.
	HeadEntry string `json:"headEntry"`
	HeadSeq   uint64 `json:"headSeq"`
	Epoch     uint64 `json:"epoch"`
	// Hex, the joining device's public halves, learned from the confirmed
	// pairing and not from the relay.
	PubSign string `json:"pubSign"`
	PubEnc  string `json:"pubEnc"`
	// The pseudonym sealed into the entry, readable only by devices holding
	// this epoch's profile key.
	Label string `json:"label"`
}

// handleAddDevice authors the roster entry that puts a paired device on the
// account.
//
// WITHOUT THIS, PAIRING WAS THEATRE. Two devices could complete SPAKE2, show
// identical emoji, and hand over the account key -- and the account itself
// never learned the second device existed, because a roster entry is the only
// thing that says so. The panel toasted "Device added" over an account with
// one device in it.
//
// Signed with the EPOCH key, not the root: adding a device is an ordinary
// operation any attached device may perform, and reserving the root key for
// epoch changes is what keeps it offline in the user's recovery phrase rather
// than in memory on every machine.
//
// The previous hash comes from the head THIS device verified. Taking the
// server's word for the head is how a chain gets forked: a relay could serve
// one head to one device and another head to another, and both would append
// happily to different histories.
func handleAddDevice(req Request) (any, error) {
	var in addDeviceRequest
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	pubSign, err := hex.DecodeString(in.PubSign)
	if err != nil || len(pubSign) != ed25519.PublicKeySize {
		return nil, codedf(ErrConfigInvalid, "pubSign is 32 bytes of hex")
	}
	pubEnc, err := hex.DecodeString(in.PubEnc)
	if err != nil || len(pubEnc) != 32 {
		return nil, codedf(ErrConfigInvalid, "pubEnc is 32 bytes of hex")
	}
	headWire, err := base64.StdEncoding.DecodeString(in.HeadEntry)
	if err != nil || len(headWire) == 0 {
		return nil, codedf(ErrConfigInvalid, "headEntry is base64 of the chain head")
	}

	keys.mu.RLock()
	acct := keys.account
	epoch, haveEpoch := keys.epochs[in.Epoch]
	loaded := keys.loaded
	keys.mu.RUnlock()
	if !loaded || !haveEpoch {
		return nil, codedf(ErrNotPaired, "no account is loaded for that epoch")
	}

	head, _, err := protocol.DecodeEntry(headWire)
	if err != nil {
		return nil, wrapCoded(ErrRosterInvalid, err, "reading the chain head")
	}
	prev, err := head.Hash()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "hashing the chain head")
	}

	labelCT, err := protocol.SealLabel(in.Label, acct, in.Epoch, pubSign, epoch.Profile)
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "sealing the label")
	}
	nonce, err := protocol.Nonce()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "drawing a nonce")
	}

	e := protocol.Entry{
		AccountID: acct,
		Epoch:     in.Epoch,
		Seq:       in.HeadSeq + 1,
		PrevHash:  prev,
		Op:        protocol.OpAdd,
		Signer:    protocol.SignerAK,
		Nonce:     nonce,
		PubSign:   pubSign,
		PubEnc:    pubEnc,
		LabelCT:   labelCT,
		TS:        uint64(time.Now().UnixMilli()),
	}
	body, err := e.Encode()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "encoding the entry")
	}
	e.Sig = ed25519.Sign(epoch.Sign, body)
	wire, err := e.Wire()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "encoding the entry")
	}
	return map[string]any{
		"seq":   e.Seq,
		"entry": base64.StdEncoding.EncodeToString(wire),
	}, nil
}

type verifyRosterRequest struct {
	// Base64 of the concatenated chain, exactly as the relay serves it.
	Chain string `json:"chain"`
	// Hex of RK_sign's public half and of epoch 1's AK_sign public half. FROM
	// THE CALLER, never from the server: a chain verified against a key the
	// server supplied is not verified, and that is the single most important
	// sentence in this file.
	RootSignPub  string `json:"rootSignPub"`
	Epoch1Sign   string `json:"epoch1Sign"`
	PinnedSeq    uint64 `json:"pinnedSeq"`
	PinnedHead   string `json:"pinnedHead"`
	HavePinnedAt bool   `json:"havePin"`
}

func handleVerifyRoster(req Request) (any, error) {
	var in verifyRosterRequest
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	chain, err := base64.StdEncoding.DecodeString(in.Chain)
	if err != nil {
		return nil, codedf(ErrConfigInvalid, "chain is not base64")
	}
	rootPub, err := hex.DecodeString(in.RootSignPub)
	if err != nil || len(rootPub) != ed25519.PublicKeySize {
		return nil, codedf(ErrConfigInvalid, "rootSignPub is 32 bytes of hex")
	}
	epoch1, err := hex.DecodeString(in.Epoch1Sign)
	if err != nil || len(epoch1) != ed25519.PublicKeySize {
		return nil, codedf(ErrConfigInvalid, "epoch1Sign is 32 bytes of hex")
	}

	var pin *protocol.Pin
	if in.HavePinnedAt {
		head, err := hex.DecodeString(in.PinnedHead)
		if err != nil {
			return nil, codedf(ErrConfigInvalid, "pinnedHead is hex")
		}
		pin = &protocol.Pin{Seq: in.PinnedSeq, Hash: head}
	}

	keys.mu.RLock()
	acct := keys.account
	self := keys.device
	loaded := keys.loaded
	keys.mu.RUnlock()
	if !loaded {
		return nil, codedf(ErrNotPaired, "no account is loaded")
	}

	v, err := protocol.VerifyChain(chain, acct, rootPub, epoch1, pin)
	if err != nil {
		switch {
		case errors.Is(err, protocol.ErrForked):
			return nil, wrapCoded(ErrRosterForked, err, "verifying the roster")
		case errors.Is(err, protocol.ErrRewound):
			return nil, wrapCoded(ErrRosterRewound, err, "verifying the roster")
		default:
			return nil, wrapCoded(ErrRosterInvalid, err, "verifying the roster")
		}
	}

	// `Devices` is the LIVE set: the verifier applies revocations as it walks
	// the chain, so a revoked device is absent rather than flagged. That makes
	// "am I still here" the whole question, and it is a stronger one than a
	// flag -- there is no field a forged entry could set to claim otherwise.
	devices := make([]map[string]any, 0, len(v.Devices))
	for _, d := range v.Devices {
		row := map[string]any{
			"pubSign":       hex.EncodeToString(d.PubSign),
			"pubEnc":        hex.EncodeToString(d.PubEnc),
			"epoch":         d.Epoch,
			"mnemonicAdded": d.MnemonicAuthored(),
		}
		// The pseudonym, opened HERE or not at all: it is sealed under the
		// profile key of the epoch the device was added in, and that key never
		// leaves this process. Omitted rather than faked when this device does
		// not hold that epoch -- which is the ordinary state for a device that
		// joined after a rotation, not an error. The parent shows the key's
		// first bytes in that case, which is at least true.
		keys.mu.RLock()
		epoch, have := keys.epochs[d.Epoch]
		acct := keys.account
		keys.mu.RUnlock()
		if have && len(d.LabelCT) > 0 {
			if label, err := protocol.OpenLabel(d.LabelCT, acct, d.Epoch, d.PubSign, epoch.Profile); err == nil {
				row["label"] = label
			}
		}
		devices = append(devices, row)
	}

	// Whether THIS device is still in the roster, which is the question the
	// revocation wipe is waiting on. Answered here rather than by the parent
	// comparing keys, because the comparison IS the security property and it
	// belongs where the device key actually is.
	stillListed := false
	if self != nil {
		mine := self.Sign.Public().(ed25519.PublicKey)
		for _, d := range v.Devices {
			if ed25519.PublicKey(d.PubSign).Equal(mine) {
				stillListed = true
			}
		}
	}

	return map[string]any{
		"devices": devices,
		// TWO different things, and conflating them is what broke pairing.
		// `head` is H(last entry) -- hex, because it is a pin a client
		// remembers and compares. `headEntry` is that entry's own bytes --
		// base64, because it is a blob, and it is what `addDevice` and
		// `pairHandoff` both need: one hashes it for the next entry's
		// prev_hash, the other seals it so the joining device can verify the
		// chain it is about to fetch instead of trusting the relay's copy.
		//
		// Until this was added, `verifyRoster` handed out only the hash while
		// both callers wanted the entry, so every pairing died one step AFTER
		// the emoji matched -- the worst place for it, because by then the
		// user has been told the two devices agree.
		"head":       hex.EncodeToString(v.Head),
		"headEntry":  base64.StdEncoding.EncodeToString(v.HeadEntry),
		"headSeq":    v.HeadSeq,
		"epoch":      v.Epoch,
		"entries":    v.Entries,
		"selfListed": stillListed,
	}, nil
}

// --- fingerprint ---

func handleFingerprint(req Request) (any, error) {
	var in struct {
		Head string `json:"head"`
	}
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	head, err := hex.DecodeString(in.Head)
	if err != nil {
		return nil, codedf(ErrConfigInvalid, "head is hex")
	}
	keys.mu.RLock()
	acct := keys.account
	loaded := keys.loaded
	keys.mu.RUnlock()
	if !loaded {
		return nil, codedf(ErrNotPaired, "no account is loaded")
	}
	words, err := protocol.Fingerprint(head, acct)
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "computing the fingerprint")
	}
	return map[string]any{"words": words}, nil
}

func decodeParams(req Request, into any) error {
	if len(req.Params) == 0 {
		return codedf(ErrConfigInvalid, "%s needs parameters", req.Method)
	}
	// DisallowUnknownFields: a parameter the sidecar does not know is a
	// parent and a sidecar that disagree about the protocol, and silently
	// ignoring it is how that disagreement survives to the point where it
	// matters. Cheap here, because both sides ship together.
	dec := json.NewDecoder(bytes.NewReader(req.Params))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		return wrapCoded(ErrConfigInvalid, err, "reading %s parameters", req.Method)
	}
	return nil
}

// --- request authorization ---

type signRequestParams struct {
	Method string `json:"method"`
	// Path WITHOUT the query string. The server rebuilds the authorization
	// from its own view of the request and compares, so a client that signed
	// the query would sign something the server never reconstructs.
	Path string `json:"path"`
	// Base64 of the request body, or empty for none.
	Body string `json:"body"`
}

type signLoginParams struct {
	// Hex, the server's challenge nonce from POST /v1/auth/challenge.
	ServerNonce string `json:"serverNonce"`
	// Hex, SHA-256 of the instance's TLS SubjectPublicKeyInfo. The TOFU pin
	// from the addy:// join string.
	ServerSPKI string `json:"serverSPKI"`
}

// handleSignLogin signs the login the relay asks for before it will issue a
// token.
//
// SEPARATE FROM handleSignRequest, and not a flag on it, because they sign
// different things under different domain prefixes -- `addy-login-v1` against
// `addy-authz-v1`. That separation is the reason a signature obtained for one
// purpose cannot be replayed as the other, and collapsing them into one
// handler with a mode would put that guarantee behind an argument.
//
// The device nonce and the timestamp are drawn HERE, for the reason the
// request signer gives: a caller that chose its own could reuse one, and the
// server spends a nonce per device.
//
// ServerSPKI is a parameter rather than something this process discovers. It
// is the TLS pin, and the process holding the account key does not have a
// socket to learn it from -- main does the transport, this does the signing,
// and that split is the whole shape of the sidecar.
func handleSignLogin(req Request) (any, error) {
	var in signLoginParams
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	serverNonce, err := hex.DecodeString(in.ServerNonce)
	if err != nil {
		return nil, codedf(ErrConfigInvalid, "serverNonce is not hex")
	}
	spki, err := hex.DecodeString(in.ServerSPKI)
	if err != nil {
		return nil, codedf(ErrConfigInvalid, "serverSPKI is not hex")
	}

	keys.mu.RLock()
	acct := keys.account
	device := keys.device
	loaded := keys.loaded
	keys.mu.RUnlock()
	if !loaded || device == nil {
		return nil, codedf(ErrNotPaired, "no account is loaded")
	}

	deviceNonce, err := protocol.Nonce()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "drawing a nonce")
	}
	login := protocol.Login{
		AccountID:   acct,
		DeviceNonce: deviceNonce,
		ServerNonce: serverNonce,
		ServerSPKI:  spki,
		TS:          uint64(time.Now().UnixMilli()),
	}
	sig, err := protocol.Sign(device.Sign, login)
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "signing the login")
	}
	return map[string]any{
		"account":     acct.String(),
		"device":      hex.EncodeToString(device.Sign.Public().(ed25519.PublicKey)),
		"deviceNonce": hex.EncodeToString(deviceNonce),
		"ts":          login.TS,
		"signature":   hex.EncodeToString(sig),
	}, nil
}

// handleSignRequest signs one API request authorization.
//
// THE PARENT DOES THE HTTP AND THIS PROCESS DOES THE SIGNING, which is the
// whole shape of the split: main already has an HTTP client, a proxy
// configuration and a certificate store, and none of that should be linked
// into the process holding the account key. What crosses the boundary is a
// method, a path and a body hash -- never a key, and never a socket.
//
// The nonce is drawn HERE rather than passed in. A caller that chose its own
// could reuse one, and the server spends a nonce per device: a replayed
// authorization is refused, which would look to the parent like an
// intermittent network failure rather than like the bug it is.
func handleSignRequest(req Request) (any, error) {
	var in signRequestParams
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	if in.Method == "" || in.Path == "" {
		return nil, codedf(ErrConfigInvalid, "signRequest needs a method and a path")
	}
	if strings.ContainsRune(in.Path, '?') {
		// Refused rather than trimmed. Trimming would sign something other
		// than what the caller asked for, silently, and the failure would
		// appear at the server as a bad signature with no hint where it came
		// from.
		return nil, codedf(ErrConfigInvalid, "path carries a query string; sign the path alone")
	}

	var body []byte
	if in.Body != "" {
		decoded, err := base64.StdEncoding.DecodeString(in.Body)
		if err != nil {
			return nil, codedf(ErrConfigInvalid, "body is not base64")
		}
		body = decoded
	}

	keys.mu.RLock()
	acct := keys.account
	device := keys.device
	loaded := keys.loaded
	keys.mu.RUnlock()
	if !loaded || device == nil {
		return nil, codedf(ErrNotPaired, "no account is loaded")
	}

	nonce, err := protocol.Nonce()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "drawing a nonce")
	}
	authz := protocol.Authz{
		AccountID:   acct,
		DeviceNonce: nonce,
		Method:      in.Method,
		Path:        in.Path,
		BodyHash:    protocol.HashBody(body),
	}
	sig, err := protocol.Sign(device.Sign, authz)
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "signing the request")
	}
	return map[string]any{
		"nonce":     hex.EncodeToString(nonce),
		"signature": hex.EncodeToString(sig),
	}, nil
}

// handleWhoami reports which account and device this process is holding.
//
// Needed because several operations name the device in a collection name or a
// recipient field, and the parent must not be the party that remembers it: a
// parent that tracked the device key separately could drift from the one
// actually loaded, and the symptom would be a seal nobody can open.
func handleWhoami(Request) (any, error) {
	keys.mu.RLock()
	defer keys.mu.RUnlock()
	if !keys.loaded || keys.device == nil {
		return nil, codedf(ErrNotPaired, "no account is loaded")
	}
	return map[string]any{
		"accountId": keys.account.String(),
		"devicePub": hex.EncodeToString(keys.device.Sign.Public().(ed25519.PublicKey)),
		// The encryption half too. Public, and needed by anything that writes
		// this device into a roster entry — which previously meant the caller
		// had to have learned it from a pairing and kept it, so a device that
		// had only ever resumed did not know its own.
		"deviceEnc": hex.EncodeToString(keys.device.Enc.PublicKey().Bytes()),
		"epochs":    epochNumbers(keys.epochs),
	}, nil
}

// --- minting an account ---

// handleCreateAccount mints an account from nothing.
//
// EVERYTHING IS GENERATED HERE AND THE PARENT IS TOLD ONLY WHAT IT MUST
// STORE. The mnemonic comes back once, because the user has to write it down
// and nothing else will ever be able to show it to them again; the secrets
// come back so the parent can put them in the keychain, which is the only
// durable store on the machine; and the genesis entry comes back so the parent
// can POST it, because the parent owns the HTTP client and this process must
// not.
//
// The account is NOT registered by this call. Registration needs an invite and
// a network round trip, and a sidecar that made one would be a sidecar with a
// socket -- which is the thing the split exists to avoid.
func handleCreateAccount(req Request) (any, error) {
	var in struct {
		// The device's pseudonym, shown in the device list on every device of
		// the account.
		Label string `json:"label"`
	}
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	if in.Label == "" {
		return nil, codedf(ErrConfigInvalid, "a device needs a label; it is what the device list shows")
	}

	acct, err := protocol.NewAccount(in.Label)
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "minting an account")
	}

	id := protocol.DeriveAccountID(acct.Root.Sign.Public().(ed25519.PublicKey))

	genesisWire, err := acct.Genesis.Wire()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "encoding the genesis entry")
	}

	// Loaded immediately, so the very next call works without the parent
	// having to hand back what it was just given.
	keys.mu.Lock()
	keys.account = id
	keys.device = acct.Device
	keys.rootSignPub = acct.Root.Sign.Public().(ed25519.PublicKey)
	keys.epochs = map[uint64]*protocol.EpochKeys{1: acct.Epoch}
	keys.loaded = true
	keys.mu.Unlock()

	return map[string]any{
		"accountId": id.String(),
		// SHOWN ONCE. There is no call that returns it again, and that is not
		// an oversight: a mnemonic a process will hand back on request is a
		// mnemonic that leaks the day something can ask.
		"mnemonic":    acct.Mnemonic,
		"rootSignPub": hex.EncodeToString(acct.Root.Sign.Public().(ed25519.PublicKey)),
		// EPOCH 1'S SIGNING PUBLIC HALF, returned for the same reason as the
		// root's and it was missing. `verifyRoster` takes both FROM THE CALLER
		// and never from the server -- a chain verified against a key the
		// server supplied is not verified -- so a client that cannot record
		// this one at mint time can never verify its own roster afterwards.
		"epoch1SignPub": hex.EncodeToString(acct.Epoch.Sign.Public().(ed25519.PublicKey)),
		// For the keychain. The parent stores these under the machine-only
		// prefix, so they cannot ride in a backup.
		"secrets": map[string]string{
			"deviceSignSeed": base64.StdEncoding.EncodeToString(acct.Device.SignSeed),
			"deviceEncKey":   base64.StdEncoding.EncodeToString(acct.Device.Enc.Bytes()),
			"akSeed":         base64.StdEncoding.EncodeToString(acct.Epoch.AK),
		},
		// For the POST the parent makes.
		"genesis": base64.StdEncoding.EncodeToString(genesisWire),
		"escrow":  base64.StdEncoding.EncodeToString(acct.Escrow),
		"epoch":   uint64(1),
	}, nil
}

type revokeDeviceRequest struct {
	// The chain head this entry follows, base64 of the wire entry — so its
	// hash and sequence come from the chain THIS device verified rather than
	// from anything the relay asserted.
	HeadEntry string `json:"headEntry"`
	HeadSeq   uint64 `json:"headSeq"`
	Epoch     uint64 `json:"epoch"`
	// Hex, BOTH HALVES, from the verified roster.
	//
	// The encryption key is not redundant. A revoke naming a substituted
	// pub_enc is refused by the verifier, because otherwise "revoke" would be
	// a way to rewrite a live device's encryption key — so the caller has to
	// supply the pair as the chain has them, and supplying them from the
	// roster it verified is the only way to get that right.
	PubSign string `json:"pubSign"`
	PubEnc  string `json:"pubEnc"`
}

// handleRevokeDevice authors the entry that removes a device from the account.
//
// THE SOFT HALF, and it is worth being exact about what it does and does not
// do. It removes the device from the roster, so every other device stops
// sealing to it, the relay stops accepting its signatures once it re-reads the
// chain, and the device itself wipes on its next launch. What it does NOT do
// is take back AK_n: the revoked machine still holds the epoch key and can
// still open every object sealed under it that it already has, or that it
// captured.
//
// That is why a revocation for a LOST OR STOLEN device is a revoke plus a
// re-key, and why the two are separate calls with separate signers. Conflating
// them would produce exactly the hole the chained-rotation comment in
// protocol/rotate.go describes: a rotation the revoked device can follow.
func handleRevokeDevice(req Request) (any, error) {
	var in revokeDeviceRequest
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	pubSign, err := hex.DecodeString(in.PubSign)
	if err != nil || len(pubSign) != ed25519.PublicKeySize {
		return nil, codedf(ErrConfigInvalid, "pubSign is 32 bytes of hex")
	}
	pubEnc, err := hex.DecodeString(in.PubEnc)
	if err != nil || len(pubEnc) != 32 {
		return nil, codedf(ErrConfigInvalid, "pubEnc is 32 bytes of hex")
	}
	headWire, err := base64.StdEncoding.DecodeString(in.HeadEntry)
	if err != nil || len(headWire) == 0 {
		return nil, codedf(ErrConfigInvalid, "headEntry is base64 of the chain head")
	}

	keys.mu.RLock()
	acct := keys.account
	epoch, haveEpoch := keys.epochs[in.Epoch]
	device := keys.device
	loaded := keys.loaded
	keys.mu.RUnlock()
	if !loaded || !haveEpoch {
		return nil, codedf(ErrNotPaired, "no account is loaded for that epoch")
	}

	// REFUSED HERE rather than left to the verifier. A device that revokes
	// itself produces a chain in which it is absent, which is valid — and the
	// next thing that happens is this machine wipes itself on relaunch,
	// because that is what "not in the roster" means. It is almost certainly a
	// misclick on a list where one row is "this device", and it is not
	// undoable.
	if device != nil && ed25519.PublicKey(pubSign).Equal(device.Sign.Public().(ed25519.PublicKey)) {
		return nil, codedf(
			ErrConfigInvalid,
			"a device cannot revoke itself; do it from another device on the account",
		)
	}

	head, _, err := protocol.DecodeEntry(headWire)
	if err != nil {
		return nil, wrapCoded(ErrRosterInvalid, err, "reading the chain head")
	}
	prev, err := head.Hash()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "hashing the chain head")
	}
	nonce, err := protocol.Nonce()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "drawing a nonce")
	}

	e := protocol.Entry{
		AccountID: acct,
		Epoch:     in.Epoch,
		Seq:       in.HeadSeq + 1,
		PrevHash:  prev,
		Op:        protocol.OpRevoke,
		Signer:    protocol.SignerAK,
		Nonce:     nonce,
		PubSign:   pubSign,
		PubEnc:    pubEnc,
		// EMPTY, and the verifier refuses anything else: there is nothing to
		// name in a removal, so a payload here would be a covert channel in
		// bytes the server stores verbatim and cannot read.
		LabelCT: nil,
		TS:      uint64(time.Now().UnixMilli()),
	}
	body, err := e.Encode()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "encoding the entry")
	}
	e.Sig = ed25519.Sign(epoch.Sign, body)
	wire, err := e.Wire()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "encoding the entry")
	}
	return map[string]any{
		"seq":   e.Seq,
		"entry": base64.StdEncoding.EncodeToString(wire),
	}, nil
}

// ---------------------------------------------------------------------------
// Recovery, from the twelve words and nothing else
// ---------------------------------------------------------------------------
//
// TWO CALLS, AND THE SPLIT IS FORCED BY THE ORDER THINGS ARE KNOWABLE IN. The
// escrow blob lives on the relay under the account's own name, and reading it
// needs a session — so the parent has to know the account id, and hold a
// device key it can sign a login with, BEFORE it can fetch the thing that
// tells it anything else. `recoverIdentity` answers exactly that much;
// `recoverOpen` does the rest once the bytes are in hand.
//
// What recovery is NOT: a second way in that skips the roster. The escrow
// carries the head entry as the account committed it, so the chain fetched
// from the relay is verified against a pin the relay never saw — a relay that
// served a truncated or forged chain to a recovering device is caught here,
// which is the moment it would be most worth trying.

type recoverIdentityRequest struct {
	// The twelve words. Whitespace is the user's problem to get wrong and
	// ours to forgive, so it is normalised before validation.
	Mnemonic string `json:"mnemonic"`
	// What this machine will be called on the roster it is about to rejoin.
	Label string `json:"label"`
}

// handleRecoverIdentity turns the phrase into an account id and a fresh device.
//
// The device keys are MINTED, not recovered: the phrase does not carry them
// and never did, because a device key that could be re-derived from something
// written on a card would make the card sufficient to impersonate a machine.
// So a recovered device is a NEW device that the root key vouches for, which
// is also why recovery ends with a roster entry rather than with a claim.
func handleRecoverIdentity(req Request) (any, error) {
	var in recoverIdentityRequest
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.Label) == "" {
		return nil, codedf(ErrConfigInvalid, "a label is required, so the roster can name this device")
	}
	phrase := strings.Join(strings.Fields(strings.ToLower(in.Mnemonic)), " ")
	root, err := protocol.RootFromMnemonic(phrase)
	if err != nil {
		// The phrase, not the error, is what is wrong — and the message must
		// not echo any of it back: this process redacts recovery phrases out
		// of its own log for the same reason.
		return nil, codedf(ErrConfigInvalid, "that is not a valid recovery phrase")
	}

	dev, err := protocol.NewDeviceKeys()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "minting this device's keys")
	}

	keys.mu.Lock()
	keys.account = root.AccountID
	keys.device = dev
	keys.rootSignPub = root.Sign.Public().(ed25519.PublicKey)
	keys.epochs = map[uint64]*protocol.EpochKeys{}
	// LOADED, so `signLogin` works on the very next call — which is the whole
	// point of this being the first half. NOT loaded with an epoch key: there
	// is none until the escrow opens, and a caller that tried to seal now
	// would be told so rather than sealing under something invented.
	keys.loaded = true
	keys.mu.Unlock()

	// Held for the second call rather than handed to the parent. RK_enc opens
	// the escrow and RK_sign authorises an epoch change; the parent has a
	// keychain but no reason to hold the keys to the whole estate, and a value
	// that crosses the pipe is a value in a log the day somebody adds one.
	recovery.mu.Lock()
	recovery.root = root
	recovery.label = in.Label
	recovery.mu.Unlock()

	return map[string]any{
		"accountId":   root.AccountID.String(),
		"rootSignPub": hex.EncodeToString(root.Sign.Public().(ed25519.PublicKey)),
		"devicePub":   hex.EncodeToString(dev.Sign.Public().(ed25519.PublicKey)),
		"secrets": map[string]string{
			"deviceSignSeed": base64.StdEncoding.EncodeToString(dev.SignSeed),
			"deviceEncKey":   base64.StdEncoding.EncodeToString(dev.Enc.Bytes()),
		},
	}, nil
}

// recovery holds RK between the two halves of a recovery, and nowhere else.
var recovery struct {
	mu   sync.Mutex
	root *protocol.RootKeys
	// AK_1's signing public half, learned from epoch 1's escrow and remembered
	// across the second call.
	//
	// Needed because the GENESIS entry is AK-signed at epoch 1, so a chain
	// cannot be verified without it — and an account that has rotated keeps
	// its current key in a LATER escrow. So recovery opens epoch 1's escrow
	// first whatever the account's epoch is: that one is what makes the chain
	// checkable, and the later one is what makes the account usable.
	epoch1Sign ed25519.PublicKey
	label      string
}

type recoverOpenRequest struct {
	// The escrow object, base64, as the relay serves it.
	Escrow string `json:"escrow"`
	// Which epoch's escrow this is. Zero means epoch 1, which is where an
	// account that has never rotated keeps its only one — and where a caller
	// that has not yet been told otherwise has to start, because the current
	// epoch is not knowable until the chain has been verified, and the chain
	// cannot be verified without an epoch key.
	Epoch uint64 `json:"epoch"`
	// The roster chain, base64, as the relay serves it.
	Chain string `json:"chain"`
}

// handleRecoverOpen opens the escrow and authors this device's way back in.
func handleRecoverOpen(req Request) (any, error) {
	var in recoverOpenRequest
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}

	recovery.mu.Lock()
	root := recovery.root
	label := recovery.label
	recovery.mu.Unlock()
	if root == nil {
		return nil, codedf(ErrConfigInvalid, "no recovery is in progress; start with the phrase")
	}

	sealed, err := base64.StdEncoding.DecodeString(in.Escrow)
	if err != nil || len(sealed) == 0 {
		return nil, codedf(ErrConfigInvalid, "the escrow is base64 of the sealed object")
	}
	chain, err := base64.StdEncoding.DecodeString(in.Chain)
	if err != nil || len(chain) == 0 {
		return nil, codedf(ErrConfigInvalid, "the chain is base64 of the roster")
	}

	// Sealed to RK_enc at its own epoch, counter 1 — each (name, epoch) pair
	// is a distinct object on the relay and starts its own count.
	// `seenCounter` 0 because a recovering device has seen nothing; it is
	// recovering.
	askEpoch := in.Epoch
	if askEpoch == 0 {
		askEpoch = 1
	}
	esc, err := protocol.OpenEscrow(sealed, root.AccountID, askEpoch, 1, root.Enc, 0)
	if err != nil {
		// A refusal here is the relay handing over an escrow for a different
		// account, or a corrupted one. Either way the phrase is not at fault
		// and saying "wrong phrase" would send somebody to hunt for a card
		// that is fine.
		return nil, wrapCoded(ErrPairingRefused, err, "opening the escrow for this account")
	}

	epochKeys, err := protocol.DeriveEpoch(esc.AKSeed, esc.AccountID, esc.Epoch)
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "deriving the epoch key")
	}

	// THE CHAIN, VERIFIED AGAINST THE ESCROW'S OWN HEAD. The pin comes from a
	// blob the account sealed to itself, so a relay that serves a truncated
	// chain — dropping the entry that revoked a device it would rather stayed
	// — is caught. This is the moment that attack is most worth trying, and it
	// is the reason the escrow carries the whole head entry rather than a
	// hash: a recovering device has nothing else to compare against.
	head, _, err := protocol.DecodeEntry(esc.HeadEntry)
	if err != nil {
		return nil, wrapCoded(ErrRosterInvalid, err, "reading the escrowed head")
	}
	headHash, err := head.Hash()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "hashing the escrowed head")
	}
	recovery.mu.Lock()
	if esc.Epoch == 1 {
		recovery.epoch1Sign = epochKeys.Sign.Public().(ed25519.PublicKey)
	}
	epoch1Sign := recovery.epoch1Sign
	recovery.mu.Unlock()
	if epoch1Sign == nil {
		// Reached only by a caller that skipped epoch 1's escrow. Said as a
		// sequencing error rather than as a verification failure, because the
		// chain is fine and the caller is simply asking in the wrong order.
		return nil, codedf(
			ErrConfigInvalid,
			"open epoch 1's escrow first; the genesis entry cannot be verified without its key",
		)
	}
	verified, err := protocol.VerifyChain(
		chain, root.AccountID, root.Sign.Public().(ed25519.PublicKey),
		epoch1Sign,
		&protocol.Pin{Seq: head.Seq, Hash: headHash},
	)
	if err != nil {
		return nil, wrapCoded(ErrRosterInvalid, err, "verifying the roster against the escrowed head")
	}

	keys.mu.Lock()
	device := keys.device
	// UNDER THE EPOCH IT BELONGS TO, and only that one. An escrow written at
	// epoch n carries AK_n; filing it under the chain's current epoch as well
	// would mean sealing future writes under a key the account has moved off,
	// and every other device would refuse to open them.
	keys.epochs[esc.Epoch] = epochKeys
	keys.mu.Unlock()
	if device == nil {
		return nil, codedf(ErrNotPaired, "no recovery is in progress; start with the phrase")
	}

	// A rotation happened after this escrow was written, so the key just
	// recovered reads history and nothing current. The caller is told which
	// epoch's escrow to fetch next rather than being handed a key that looks
	// usable and is not — the account's own escrow object is re-sealed at
	// every rotation for exactly this.
	if verified.Epoch > esc.Epoch {
		return map[string]any{
			"accountId": root.AccountID.String(),
			"epoch":     esc.Epoch,
			"needEpoch": verified.Epoch,
			"devices":   len(verified.Devices),
		}, nil
	}

	// This device's way back onto the roster, SIGNED BY THE ROOT KEY.
	//
	// Not by AK_n, even though this process now holds it. The root key is
	// what the phrase proves possession of, and an entry signed by AK_n would
	// be indistinguishable from one written by any device that already had it
	// — including a revoked one. A verifier can tell a recovery from an
	// ordinary pairing by the signer, and `mnemonicAdded` on the device list
	// is that distinction surfaced to a person reviewing their devices.
	pubSign := device.Sign.Public().(ed25519.PublicKey)
	pubEnc := device.Enc.PublicKey().Bytes()
	labelCT, err := protocol.SealLabel(label, root.AccountID, verified.Epoch, pubSign, epochKeys.Profile)
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "sealing the label")
	}
	nonce, err := protocol.Nonce()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "drawing a nonce")
	}
	e := protocol.Entry{
		AccountID: root.AccountID,
		Epoch:     verified.Epoch,
		Seq:       verified.HeadSeq + 1,
		PrevHash:  verified.Head,
		Op:        protocol.OpAdd,
		Signer:    protocol.SignerRK,
		Nonce:     nonce,
		PubSign:   pubSign,
		PubEnc:    pubEnc,
		LabelCT:   labelCT,
		TS:        uint64(time.Now().UnixMilli()),
	}
	body, err := e.Encode()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "encoding the entry")
	}
	e.Sig = ed25519.Sign(root.Sign, body)
	wire, err := e.Wire()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "encoding the entry")
	}

	return map[string]any{
		"accountId":     root.AccountID.String(),
		"epoch":         verified.Epoch,
		"rootSignPub":   hex.EncodeToString(root.Sign.Public().(ed25519.PublicKey)),
		"epoch1SignPub": hex.EncodeToString(epochKeys.Sign.Public().(ed25519.PublicKey)),
		// What the user has to look at before this is over. Recovery is the one
		// path where the honest next question is "is everything on this list
		// still yours", because whoever else read the card is on it too.
		"devices": len(verified.Devices),
		"seq":     e.Seq,
		"entry":   base64.StdEncoding.EncodeToString(wire),
		"secrets": map[string]string{
			"akSeed": base64.StdEncoding.EncodeToString(esc.AKSeed),
		},
	}, nil
}

// handleRecoverForget drops RK the moment recovery is over, successfully or
// not. Held any longer it is the whole estate sitting in a process that has no
// further use for it.
func handleRecoverForget(Request) (any, error) {
	recovery.mu.Lock()
	recovery.root = nil
	recovery.epoch1Sign = nil
	recovery.label = ""
	recovery.mu.Unlock()
	return map[string]any{"ok": true}, nil
}

// ---------------------------------------------------------------------------
// Epoch rotation
// ---------------------------------------------------------------------------
//
// TWO KINDS, AND CONFLATING THEM IS THE BUG WAITING TO HAPPEN.
//
//   - HYGIENE is routine. AK_n signs it, and it MAY publish a chained handoff
//     so an offline device catches up through the chain without re-pairing.
//   - REVOCATION is a response to compromise. RK signs it, it MUST NOT chain,
//     and AK_{n+1} is sealed individually to each surviving device. Chaining
//     would carry the revoked device along with everyone else, which is the
//     exact thing the rotation exists to prevent.
//
// The order of the writes is normative and the CALLER owns them, because only
// the caller can talk to the relay: re-seal every collection under n+1 first,
// write the escrow, seal the handoffs, append the transition entry, and only
// then delete the old epoch's objects. Any other order has a window in which a
// device reading the chain finds an epoch whose objects do not exist yet. A
// crash between any two steps leaves the account usable at epoch n, which is
// the only acceptable failure mode.

type rotateEpochRequest struct {
	// "hygiene" or "revocation". Spelled out rather than a boolean: `rotate(true)`
	// at a call site says nothing about which of the two it is.
	Kind string `json:"kind"`
	// The roster as the relay serves it, base64. Verified here before anything
	// is signed — a rotation built on a chain this device has not checked is a
	// rotation onto whatever head the relay preferred.
	Chain string `json:"chain"`
	// Hex, the keys this device pinned at enrolment. Never from the relay.
	RootSignPub string `json:"rootSignPub"`
	Epoch1Sign  string `json:"epoch1Sign"`
	// The twelve words. REQUIRED for a revocation and refused for a hygiene
	// rotation: RK is what signs the escape from a compromised epoch key, and
	// asking for it when it is not needed trains people to type it.
	Mnemonic string `json:"mnemonic"`
}

func handleRotateEpoch(req Request) (any, error) {
	var in rotateEpochRequest
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}

	var kind protocol.RotationKind
	switch in.Kind {
	case "hygiene":
		kind = protocol.Hygiene
	case "revocation":
		kind = protocol.Revocation
	default:
		return nil, codedf(ErrConfigInvalid, `kind is "hygiene" or "revocation"`)
	}

	chain, err := base64.StdEncoding.DecodeString(in.Chain)
	if err != nil || len(chain) == 0 {
		return nil, codedf(ErrConfigInvalid, "the chain is base64 of the roster")
	}
	rootPub, err := hex.DecodeString(in.RootSignPub)
	if err != nil || len(rootPub) != ed25519.PublicKeySize {
		return nil, codedf(ErrConfigInvalid, "rootSignPub is 32 bytes of hex")
	}
	epoch1, err := hex.DecodeString(in.Epoch1Sign)
	if err != nil || len(epoch1) != ed25519.PublicKeySize {
		return nil, codedf(ErrConfigInvalid, "epoch1Sign is 32 bytes of hex")
	}

	keys.mu.RLock()
	acct := keys.account
	device := keys.device
	loaded := keys.loaded
	held := make(map[uint64]*protocol.EpochKeys, len(keys.epochs))
	for k, v := range keys.epochs {
		held[k] = v
	}
	keys.mu.RUnlock()
	if !loaded || device == nil {
		return nil, codedf(ErrNotPaired, "no account is loaded")
	}

	verified, err := protocol.VerifyChain(
		chain, acct, ed25519.PublicKey(rootPub), ed25519.PublicKey(epoch1), nil,
	)
	if err != nil {
		return nil, wrapCoded(ErrRosterInvalid, err, "verifying the roster before rotating it")
	}
	current, haveCurrent := held[verified.Epoch]
	if !haveCurrent {
		return nil, codedf(
			ErrNotPaired,
			"this device does not hold epoch %d, so it cannot rotate away from it",
			verified.Epoch,
		)
	}

	// The head entry, decoded from the chain rather than taken on trust: the
	// transition chains to it, and `PrepareRotation` hashes it itself.
	prev, err := lastEntry(chain)
	if err != nil {
		return nil, wrapCoded(ErrRosterInvalid, err, "reading the chain head")
	}

	var signer ed25519.PrivateKey
	var root *protocol.RootKeys
	if kind == protocol.Revocation {
		if strings.TrimSpace(in.Mnemonic) == "" {
			return nil, codedf(
				ErrConfigInvalid,
				"a re-key needs the recovery phrase: the compromised epoch key must not authorise the escape from itself",
			)
		}
		phrase := strings.Join(strings.Fields(strings.ToLower(in.Mnemonic)), " ")
		root, err = protocol.RootFromMnemonic(phrase)
		if err != nil {
			return nil, codedf(ErrConfigInvalid, "that is not a valid recovery phrase")
		}
		if root.AccountID != acct {
			// A phrase for a different account. Named as such rather than
			// reported as a signature failure, which would send somebody to
			// retype a card that is correct for something else.
			return nil, codedf(ErrConfigInvalid, "that recovery phrase is for a different account")
		}
		signer = root.Sign
	} else {
		if strings.TrimSpace(in.Mnemonic) != "" {
			// Refused rather than ignored. Accepting it here would teach
			// people to type the phrase for a routine operation, and a phrase
			// typed often is a phrase that ends up somewhere.
			return nil, codedf(
				ErrConfigInvalid,
				"a routine rotation does not need the recovery phrase and will not take one",
			)
		}
		signer = current.Sign
	}

	rot, err := protocol.PrepareRotation(kind, acct, verified, *prev, signer, ed25519.PublicKey(rootPub))
	if err != nil {
		return nil, wrapCoded(ErrConfigInvalid, err, "preparing the rotation")
	}

	// One handoff per SURVIVING device, sealed to that device and bound to the
	// previous epoch key — so a party that can read the roster's public
	// encryption keys, and is not already a member holding AK_n, cannot mint
	// one.
	headWire, err := prev.Wire()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "encoding the chain head")
	}
	handoffs := map[string]string{}
	for _, d := range verified.Devices {
		if err := rot.SealTo(d, acct, 1, rootPub, headWire, current.AK); err != nil {
			return nil, wrapCoded(ErrInternal, err, "sealing the new epoch key to a device")
		}
	}
	for fp, obj := range rot.Handoffs {
		handoffs[fp] = base64.StdEncoding.EncodeToString(obj)
	}

	out := map[string]any{
		"epoch":        rot.NewKeys.Epoch,
		"epochSignPub": hex.EncodeToString(rot.NewKeys.Sign.Public().(ed25519.PublicKey)),
		"handoffs":     handoffs,
		// The new seed goes back to the parent so it survives a restart. The
		// keychain is the only durable store here, and a device that rotated
		// the account and then forgot the key it rotated TO would be locked
		// out of its own estate on its next launch — by the one operation
		// whose whole purpose was keeping it in.
		"secrets": map[string]string{
			"akSeed": base64.StdEncoding.EncodeToString(rot.NewKeys.AK),
		},
	}

	// The chained handoff, hygiene only — and refused by the reader as well as
	// the writer, because a server that kept one from a hygiene rotation and
	// served it against a later revocation would hand the revoked device
	// exactly what the revocation took away.
	if kind == protocol.Hygiene {
		chained, err := rot.ChainedHandoff(acct, 1, current, rootPub, headWire)
		if err != nil {
			return nil, wrapCoded(ErrInternal, err, "sealing the chained handoff")
		}
		out["chained"] = base64.StdEncoding.EncodeToString(chained)
	}

	// The escrow, re-sealed at the new epoch. WITHOUT THIS A ROTATION BREAKS
	// RECOVERY: the phrase would open epoch 1's escrow and find a key the
	// account has moved off, and there would be no way back to the current
	// one. Only a revocation can write it, because only then is RK in hand —
	// which is the honest reason a hygiene rotation leaves the old escrow
	// standing and a recovering device is told to fetch the newest it can.
	if root != nil {
		escrow, err := protocol.SealEscrow(protocol.Escrow{
			AccountID: acct,
			Epoch:     rot.NewKeys.Epoch,
			Counter:   1,
			AKSeed:    rot.NewKeys.AK,
			HeadEntry: headWire,
		}, root.Enc.PublicKey())
		if err != nil {
			return nil, wrapCoded(ErrInternal, err, "re-sealing the escrow")
		}
		out["escrow"] = base64.StdEncoding.EncodeToString(escrow)
	}

	// HELD, so the caller can re-seal every collection under it before the
	// transition entry is appended — which is the order the whole thing
	// depends on. The entry is returned to be appended LAST.
	keys.mu.Lock()
	keys.epochs[rot.NewKeys.Epoch] = rot.NewKeys
	keys.mu.Unlock()

	wire, err := rot.Entry.Wire()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "encoding the transition")
	}
	out["seq"] = rot.Entry.Seq
	out["entry"] = base64.StdEncoding.EncodeToString(wire)
	return out, nil
}

// lastEntry returns the final entry of a chain, decoded.
func lastEntry(chain []byte) (*protocol.Entry, error) {
	var last protocol.Entry
	rest := chain
	found := false
	for len(rest) > 0 {
		e, next, err := protocol.DecodeEntry(rest)
		if err != nil {
			return nil, err
		}
		last, rest, found = e, next, true
	}
	if !found {
		return nil, errors.New("the chain is empty")
	}
	return &last, nil
}

type adoptEpochRequest struct {
	// The epoch being adopted, and the handoff sealed for it.
	Epoch   uint64 `json:"epoch"`
	Counter uint64 `json:"counter"`
	Handoff string `json:"handoff"`
	// THE ROSTER, base64, as the relay serves it. Required, and it replaced a
	// single unverified transition entry fetched on its own -- see below.
	Chain string `json:"chain"`
	// Hex of AK_1's signing public half, pinned at enrolment. Needed to verify
	// the genesis entry, which is signed by it.
	Epoch1Sign string `json:"epoch1Sign"`
	// Whether this is the CHAINED handoff -- sealed under the previous epoch's
	// own key so any device holding it can catch up -- or one sealed to this
	// device in particular.
	Chained bool `json:"chained"`
}

// handleAdoptEpoch takes the new epoch key after somebody else rotated.
//
// WITHOUT THIS A ROTATION LOCKS EVERY OTHER DEVICE OUT. The rotating device
// re-seals every collection under n+1 and publishes a handoff per survivor; a
// device that cannot read its handoff holds only AK_n, and every object it
// fetches from then on is sealed under a key it does not have.
//
// ---------------------------------------------------------------------------
// WHAT THIS USED TO GET WRONG, AND WHY IT VOIDED THE RE-KEY
// ---------------------------------------------------------------------------
//
// The first version opened the handoff, derived an epoch key from whatever
// seed it carried, and filed that under the claimed epoch. It verified no
// chain and compared the derived key against nothing. `protocol.Handoff.Adopt`
// -- which does exactly those checks and was written for this -- was called
// only from its own tests.
//
// The consequence was that a revocation rotation did not revoke. A removed
// device still holds AK_n, which is the entire premise of re-keying; AK_n is
// the binding `SealHandoff` takes. So the removed device could seal a handoff
// for epoch n+1 carrying an AK SEED OF ITS OWN CHOOSING to any surviving
// device's public key -- every input is one it possesses -- and a relay that
// served that object would have the survivor adopt it, persist it, and seal
// the estate under a key the attacker picked. The rotation was void against
// the one device it exists to defend against.
//
// `Adopt` closes it four ways at once: the chain is verified, it is pinned
// against the handoff's OWN head entry so a truncated chain is caught, the
// chain must have reached the epoch claimed, and the derived key must be the
// one the chain names. That last check is what makes an attacker-chosen seed
// fail.
//
// The transition entry is now taken FROM THE VERIFIED CHAIN rather than
// fetched separately and unverified. That mattered: the flag saying "this was
// a revocation" is what refuses a chained handoff, and reading it from an
// unverified entry meant an attacker supplying `Flags = 0` turned the refusal
// off.
func handleAdoptEpoch(req Request) (any, error) {
	var in adoptEpochRequest
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	if in.Epoch == 0 {
		return nil, codedf(ErrConfigInvalid, "an epoch is required")
	}
	obj, err := base64.StdEncoding.DecodeString(in.Handoff)
	if err != nil || len(obj) == 0 {
		return nil, codedf(ErrConfigInvalid, "the handoff is base64 of the sealed object")
	}
	chain, err := base64.StdEncoding.DecodeString(in.Chain)
	if err != nil || len(chain) == 0 {
		return nil, codedf(ErrConfigInvalid, "the chain is base64 of the roster")
	}
	epoch1, err := hex.DecodeString(in.Epoch1Sign)
	if err != nil || len(epoch1) != ed25519.PublicKeySize {
		return nil, codedf(ErrConfigInvalid, "epoch1Sign is 32 bytes of hex")
	}

	keys.mu.RLock()
	acct := keys.account
	device := keys.device
	loaded := keys.loaded
	// THE ROOT KEY THIS VAULT PINNED, not one the caller passed in. It was
	// recorded at mint, at pairing or at recovery, and never came from a relay
	// response -- so using it here needs no argument about provenance.
	rootPub := keys.rootSignPub
	previous := keys.epochs[in.Epoch-1]
	keys.mu.RUnlock()
	if !loaded || device == nil {
		return nil, codedf(ErrNotPaired, "no account is loaded")
	}
	if len(rootPub) != ed25519.PublicKeySize {
		return nil, codedf(ErrNotPaired, "this device has no pinned root key to verify a rotation with")
	}
	if previous == nil {
		// The device missed an epoch. It cannot catch up from here -- the
		// binding is the previous key and it does not have it -- and the
		// honest remedy is pairing again or recovering, not a handoff it can
		// open.
		return nil, codedf(
			ErrNotPaired,
			"this device does not hold epoch %d, so it cannot follow the change to %d",
			in.Epoch-1, in.Epoch,
		)
	}

	// VERIFIED FIRST, so everything read out of it afterwards is signed.
	verified, err := protocol.VerifyChain(
		chain, acct, ed25519.PublicKey(rootPub), ed25519.PublicKey(epoch1), nil,
	)
	if err != nil {
		return nil, wrapCoded(ErrRosterInvalid, err, "verifying the roster before adopting an epoch")
	}
	if verified.Epoch != in.Epoch {
		return nil, codedf(
			ErrRosterInvalid,
			"the chain ends in epoch %d, not the %d this handoff claims",
			verified.Epoch, in.Epoch,
		)
	}

	var h *protocol.Handoff
	if in.Chained {
		transition, err := transitionIn(chain, in.Epoch)
		if err != nil {
			return nil, wrapCoded(ErrRosterInvalid, err, "finding the transition in the verified chain")
		}
		// Refused for a revocation rotation, by the reader as well as the
		// writer: a server that kept the handoff object from a hygiene
		// rotation and served it against a later revocation transition would
		// otherwise hand the revoked device exactly what the revocation took
		// away. The entry comes out of the chain above, so the flag it is
		// refused on is one the account signed.
		h, err = protocol.ReadChainedHandoff(obj, *transition, acct, in.Counter, previous)
		if err != nil {
			return nil, wrapCoded(ErrPairingRefused, err, "opening the chained epoch handoff")
		}
	} else {
		// Sealed to THIS device, and bound to the previous epoch key.
		h, err = protocol.OpenHandoff(obj, acct, in.Epoch, in.Counter, device.Enc, previous.AK)
		if err != nil {
			return nil, wrapCoded(ErrPairingRefused, err, "opening the epoch handoff")
		}
	}

	// -----------------------------------------------------------------------
	// THE BINDING CHECKS, which are the whole point of this handler.
	// -----------------------------------------------------------------------
	//
	// These are what `protocol.Handoff.Adopt` does, done here rather than by
	// calling it. `Adopt` passes `epoch1 = nil` to the verifier for any epoch
	// above 1, and nothing in a chain ever establishes AK_1's signing key --
	// epoch 1 is the GENESIS, so there is no transition entry naming it. So
	// `Adopt` cannot verify any chain for an account that has rotated, which
	// is precisely the case it exists for. Its other three checks are exactly
	// right and are reproduced below; this device holds the pinned epoch-1 key
	// the verifier needs, which `Adopt` has no way to receive.
	//
	// (The limitation belongs upstream, in the addy repository. It is recorded
	// in docs/plans/addy-client.md rather than patched in a vendored copy.)

	// 1. THE CHAIN AGAINST THE HANDOFF'S OWN HEAD. The anti-truncation anchor:
	//    the head entry is signed, so a relay cannot forge one -- it can only
	//    serve a chain that stops short of it, which is what this catches. A
	//    chain truncated one entry before a revoke otherwise verifies cleanly
	//    and the revoked device is still in the adopted set.
	head, _, err := protocol.DecodeEntry(h.HeadEntry)
	if err != nil {
		return nil, wrapCoded(ErrRosterInvalid, err, "reading the handoff's head entry")
	}
	headHash, err := head.Hash()
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "hashing the handoff's head entry")
	}
	pinned, err := protocol.VerifyChain(
		chain, acct, ed25519.PublicKey(rootPub), ed25519.PublicKey(epoch1),
		&protocol.Pin{Seq: head.Seq, Hash: headHash},
	)
	if err != nil {
		return nil, wrapCoded(ErrRosterInvalid, err, "the chain does not match the head this handoff carries")
	}

	epochKeys, err := protocol.DeriveEpoch(h.AKSeed, acct, in.Epoch)
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "deriving the epoch key")
	}

	// 2. AND THE DERIVED KEY MUST BE THE ONE THE CHAIN NAMES.
	//
	//    This is the check that makes a re-key mean anything. A removed device
	//    still holds AK_n -- that is the entire premise of re-keying -- and
	//    AK_n is the binding `SealHandoff` takes. So it can seal a handoff for
	//    epoch n+1 carrying an AK SEED OF ITS OWN CHOOSING to any surviving
	//    device's public key: every input is one it possesses. Without this
	//    comparison the survivor adopts that key, persists it, and re-seals the
	//    estate under a key the attacker picked.
	if pinned.EpochSign == nil {
		return nil, codedf(ErrRosterInvalid, "the chain names no signing key for epoch %d", in.Epoch)
	}
	if !bytes.Equal(pinned.EpochSign, epochKeys.Sign.Public().(ed25519.PublicKey)) {
		return nil, codedf(
			ErrPairingRefused,
			"this handoff carries an epoch key the chain does not name; it was not written by a device on this account",
		)
	}

	keys.mu.Lock()
	// BOTH ARE KEPT. Objects re-sealed under n+1 land before the transition
	// entry does, so a device that has just adopted still needs n to read
	// anything that has not moved yet -- which is the reason `epochs` is a map
	// rather than one key.
	keys.epochs[in.Epoch] = epochKeys
	keys.mu.Unlock()

	return map[string]any{
		"epoch":        in.Epoch,
		"epochSignPub": hex.EncodeToString(epochKeys.Sign.Public().(ed25519.PublicKey)),
		// The AK seed goes back to the parent so it survives a restart: the
		// keychain is the only thing here with durable storage, and a device
		// that adopted an epoch and forgot it on quit would be locked out on
		// its next launch for exactly the reason this handler exists.
		"secrets": map[string]string{
			"akSeed": base64.StdEncoding.EncodeToString(h.AKSeed),
		},
	}, nil
}

// transitionIn returns the transition entry announcing one epoch, from a chain
// the caller has ALREADY verified.
//
// Named that way on purpose: the old `findTransition` took a chain nobody had
// checked and the parent fetched it in a second, independent request, so the
// entry it returned was the relay's word for what the account had signed.
func transitionIn(chain []byte, epoch uint64) (*protocol.Entry, error) {
	rest := chain
	for len(rest) > 0 {
		e, next, err := protocol.DecodeEntry(rest)
		if err != nil {
			return nil, err
		}
		if e.Op == protocol.OpEpoch && e.Epoch == epoch {
			return &e, nil
		}
		rest = next
	}
	return nil, fmt.Errorf("the chain carries no transition to epoch %d", epoch)
}

// fingerprintOf is how a handoff object is named for its recipient: the
// device's signing key as lowercase hex, matching what the rotating device
// used. Exposed so the parent can ask for its own without knowing the shape.
func handleFingerprintSelf(Request) (any, error) {
	keys.mu.RLock()
	device := keys.device
	keys.mu.RUnlock()
	if device == nil {
		return nil, codedf(ErrNotPaired, "no account is loaded")
	}
	return map[string]any{
		"fingerprint": hex.EncodeToString(device.Sign.Public().(ed25519.PublicKey)),
	}, nil
}

// ---------------------------------------------------------------------------
// Signalling
// ---------------------------------------------------------------------------
//
// THE DTLS FINGERPRINT IS THE POINT, and `protocol.Signal` says so in its own
// comment: without it inside a signature, a relay that carries the offer
// substitutes its own certificate and reads the data channel. It does not need
// to break anything -- it needs the fingerprint to be unsigned, which it was.
// `Signal` was written, exported, and referenced by nothing outside its own
// file.
//
// Both halves live in --crypto because only --crypto holds a device key. The
// SDP is parsed here, which is the one thing worth flagging: this process
// takes a string from the network and scans it for one attribute. That is a
// line scan and a hex decode, not a session-description parser -- the pion
// stack that does the real parsing stays in --rtc, where it belongs, and a
// malformed SDP fails this lookup rather than reaching anything stateful.

// fingerprintFromSDP pulls the SHA-256 DTLS fingerprint out of a session
// description. `a=fingerprint:sha-256 AB:CD:...` -- colon-separated hex, and
// the case is not guaranteed.
func fingerprintFromSDP(sdp string) ([]byte, error) {
	for _, line := range strings.Split(sdp, "\n") {
		line = strings.TrimSpace(line)
		const prefix = "a=fingerprint:sha-256 "
		if !strings.HasPrefix(strings.ToLower(line), strings.ToLower(prefix)) {
			continue
		}
		hexPart := strings.ReplaceAll(strings.ToLower(line[len(prefix):]), ":", "")
		raw, err := hex.DecodeString(hexPart)
		if err != nil || len(raw) != 32 {
			return nil, errors.New("the DTLS fingerprint is not 32 bytes of hex")
		}
		return raw, nil
	}
	// Refused rather than defaulted. A session description with no fingerprint
	// cannot be authenticated at all, and signing a zero one would make every
	// signature verify against every certificate.
	return nil, errors.New("that session description carries no SHA-256 DTLS fingerprint")
}

type signalRequest struct {
	Epoch uint64 `json:"epoch"`
	// Hex, the peer's DK_sign public half, from the roster THIS device
	// verified.
	PeerPubSign string `json:"peerPubSign"`
	// The session description this signature covers. Its fingerprint is what
	// binds the signature to the certificate that will be used.
	SDP string `json:"sdp"`
	// Hex, the roster head this device has verified, so each end notices
	// immediately that the other is on a different view of the chain -- which
	// is what a forked roster looks like from the inside.
	RosterHead string `json:"rosterHead"`
	// Hex. On an offer the peer's nonce is 32 zero bytes; on an answer it is
	// the nonce from the offer being answered.
	DeviceNonce string `json:"deviceNonce"`
	PeerNonce   string `json:"peerNonce"`
	// Verification only. `SignerPubSign` is whose signature this is; see the
	// note where it is used for why it is not the same field as PeerPubSign.
	TS            uint64 `json:"ts"`
	Signature     string `json:"signature"`
	SignerPubSign string `json:"signerPubSign"`
}

func (in signalRequest) build() (*protocol.Signal, error) {
	peer, err := hex.DecodeString(in.PeerPubSign)
	if err != nil || len(peer) != ed25519.PublicKeySize {
		return nil, codedf(ErrConfigInvalid, "peerPubSign is 32 bytes of hex")
	}
	head, err := hex.DecodeString(in.RosterHead)
	if err != nil || len(head) != 32 {
		return nil, codedf(ErrConfigInvalid, "rosterHead is 32 bytes of hex")
	}
	deviceNonce, err := hex.DecodeString(in.DeviceNonce)
	if err != nil || len(deviceNonce) != 32 {
		return nil, codedf(ErrConfigInvalid, "deviceNonce is 32 bytes of hex")
	}
	peerNonce, err := hex.DecodeString(in.PeerNonce)
	if err != nil || len(peerNonce) != 32 {
		return nil, codedf(ErrConfigInvalid, "peerNonce is 32 bytes of hex")
	}
	fp, err := fingerprintFromSDP(in.SDP)
	if err != nil {
		return nil, wrapCoded(ErrConfigInvalid, err, "reading the session description")
	}

	keys.mu.RLock()
	acct := keys.account
	loaded := keys.loaded
	keys.mu.RUnlock()
	if !loaded {
		return nil, codedf(ErrNotPaired, "no account is loaded")
	}

	return &protocol.Signal{
		AccountID:       acct,
		Epoch:           in.Epoch,
		DeviceNonce:     deviceNonce,
		PeerNonce:       peerNonce,
		PeerPubSign:     peer,
		DTLSFingerprint: fp,
		RosterHead:      head,
		TS:              in.TS,
	}, nil
}

func handleSignSignal(req Request) (any, error) {
	var in signalRequest
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	if in.DeviceNonce == "" {
		nonce, err := protocol.Nonce()
		if err != nil {
			return nil, wrapCoded(ErrInternal, err, "drawing a nonce")
		}
		in.DeviceNonce = hex.EncodeToString(nonce)
	}
	if in.PeerNonce == "" {
		// An offer answers nothing, so there is no peer nonce yet. Zeroes
		// rather than an absent field: the encoding is fixed-width and a
		// missing value would shift every field after it.
		in.PeerNonce = hex.EncodeToString(make([]byte, 32))
	}
	in.TS = uint64(time.Now().UnixMilli())

	signal, err := in.build()
	if err != nil {
		return nil, err
	}

	keys.mu.RLock()
	device := keys.device
	keys.mu.RUnlock()
	if device == nil {
		return nil, codedf(ErrNotPaired, "no account is loaded")
	}

	sig, err := protocol.Sign(device.Sign, *signal)
	if err != nil {
		return nil, wrapCoded(ErrInternal, err, "signing the signal")
	}
	return map[string]any{
		"signature":   hex.EncodeToString(sig),
		"deviceNonce": in.DeviceNonce,
		"ts":          in.TS,
		"fingerprint": hex.EncodeToString(signal.DTLSFingerprint),
	}, nil
}

// handleVerifySignal checks a signal against the SDP it arrived with.
//
// The SDP is passed in so the fingerprint is taken from the description this
// device is ABOUT TO USE, not from anything the envelope claims. A relay that
// rewrites the certificate has to rewrite the fingerprint in the SDP with it,
// and that is the value the signature covers.
func handleVerifySignal(req Request) (any, error) {
	var in signalRequest
	if err := decodeParams(req, &in); err != nil {
		return nil, err
	}
	signal, err := in.build()
	if err != nil {
		return nil, err
	}
	sig, err := hex.DecodeString(in.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return nil, codedf(ErrConfigInvalid, "signature is 64 bytes of hex")
	}
	// TWO DIFFERENT KEYS, and conflating them is why this refused everything
	// on the first attempt.
	//
	// `Signal.PeerPubSign` is the RECIPIENT as the signer named it — so when
	// verifying, that field is this device's own key, because we are the
	// recipient. The key the signature is checked against is the SIGNER's, and
	// it has to come from the roster this device verified rather than from the
	// envelope, or the envelope would be vouching for itself.
	signerRaw, err := hex.DecodeString(in.SignerPubSign)
	if err != nil || len(signerRaw) != ed25519.PublicKeySize {
		return nil, codedf(ErrConfigInvalid, "signerPubSign is 32 bytes of hex")
	}
	if err := protocol.Verify(ed25519.PublicKey(signerRaw), *signal, sig); err != nil {
		return nil, wrapCoded(
			ErrPeerUnreachable, err,
			"this session description was not signed by the device it claims to be from",
		)
	}
	return map[string]any{"ok": true, "fingerprint": hex.EncodeToString(signal.DTLSFingerprint)}, nil
}
