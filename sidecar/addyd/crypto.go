package main

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
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
