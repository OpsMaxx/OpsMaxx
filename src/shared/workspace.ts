// Minimum length of a workspace password.
//
// Shared because both sides enforce it: wslock.ts refuses a shorter one in the
// main process, and WorkspaceManager.tsx disables the form and counts the
// characters in the renderer. Those were two copies of a `6` kept in step by
// hand, with a comment on each saying so — the same arrangement that let the
// vault's minimum drift to three different numbers in one session, which is
// why VAULT_MIN_PASSWORD now lives in shared/vault.ts. One value, imported
// twice.
//
// Deliberately NOT the vault's VAULT_MIN_PASSWORD (12), and the difference is
// the difference between the two things. The vault's password derives the AES
// key that encrypts the vault file, so its length is the whole of the work an
// offline attacker has to do against a file they already hold. This password
// derives no key and decrypts nothing: it is a scrypt verifier compared in
// main, and what it gates is which workspaces the renderer will show. The data
// it hides is plaintext in opsmaxx-data.json either way (see wslock.ts's note,
// and SECURITY.md's table), so someone who can read the file does not need to
// beat this number, and someone who cannot read the file is typing guesses
// into a UI. Twelve characters would not buy a bit of security it could spend;
// it would only make a second, stricter gate people hit when switching
// workspaces several times a day.
export const WS_MIN_PASSWORD = 6
