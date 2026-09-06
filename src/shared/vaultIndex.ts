// The vault, named but never valued.
//
// `window.shellpilot.vault.list()` returns every entry WITH its password in it,
// which is why `vault` is one of the three namespaces a module may not touch
// (`MODULE_FORBIDDEN_BRIDGE`). But a module can have a legitimate need to let
// somebody CHOOSE an entry -- the `.env` write does, and so would anything else
// that hands main a reference for main to resolve.
//
// So this is a second, separate namespace whose whole contract is that it
// carries no secret. It is not a filtered call on the vault namespace: the
// namespace is the unit the guard works in, and a names-only method sitting
// beside `list()` would make `shellpilot.vault` legal for modules again and put
// the two one typo apart.
//
// WHAT IS ON THE DESCRIPTOR IS EVERYTHING IT MAY EVER CARRY. There is no field
// here that could hold a password, key material, or a custom field's value --
// `fieldKeys` is a list of KEYS, which are labels the operator typed. Adding a
// value to this type is a code review, not an accident.

export interface VaultEntryDescriptor {
  id: string
  name: string
  kind: string
  /** Which slots on this entry actually have something in them, so a picker can
   *  say so without being told what. */
  has: { password: boolean; privateKey: boolean; username: boolean }
  /** The KEYS of the entry's custom fields. Never their values. */
  fieldKeys: string[]
}

export type VaultIndexResult =
  | { ok: true; entries: VaultEntryDescriptor[] }
  | { ok: false; error: string }

/**
 * The projection, as a function with an EXPLICIT return type.
 *
 * That annotation is the safety, not decoration. The first version built this
 * object inline in the IPC handler, and adding `password: e.password` to it
 * type-checked cleanly: an object literal whose type is only inferred and then
 * widened at the call site gets no excess-property check, so main could grow a
 * secret field on a descriptor without any gate noticing. Annotated here, the
 * same addition is a compile error.
 *
 * Takes a structural shape rather than importing `VaultEntry`: this file is the
 * names-only vocabulary, and importing the type that HAS the password would put
 * it one hop from every consumer that exists to avoid it.
 */
export function toVaultDescriptor(e: {
  id: string
  name: string
  kind: string
  username?: string
  password?: string
  privateKey?: string
  fields?: { key: string }[]
}): VaultEntryDescriptor {
  return {
    id: e.id,
    name: e.name,
    kind: e.kind,
    has: {
      password: typeof e.password === 'string' && e.password !== '',
      privateKey: typeof e.privateKey === 'string' && e.privateKey !== '',
      username: typeof e.username === 'string' && e.username !== ''
    },
    fieldKeys: (e.fields ?? []).map((f) => f.key)
  }
}
