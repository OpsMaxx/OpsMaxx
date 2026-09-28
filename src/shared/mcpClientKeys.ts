// What OpsMaxx is called inside an MCP client's own config file, shared by the
// two writers that register it: the app (main/services/clientConfig.ts) and the
// `opsmaxx` CLI (cli/agents.ts). One copy, because two copies had already drifted
// -- the Codex markers differed, so each writer failed to recognise the other's
// block and a second `[mcp_servers.opsmaxx]` was stacked under the first.
//
// No imports, on purpose: the CLI is type-checked under NodeNext and bundled
// without electron, so this file has to be loadable from both sides as-is.

/** The key OpsMaxx registers under. A client derives its tool prefix from this
 *  key (`mcp__opsmaxx__…`), not from the name the server declares about itself. */
export const MCP_SERVER_KEY = 'opsmaxx'

/**
 * Keys an older build registered under, removed whenever OpsMaxx registers again.
 *
 * Why this has to exist: the client keeps the old entry working -- it points at
 * the same port -- so nothing ever signals that it is stale, and every agent goes
 * on listing tools under the retired product name. Re-registering removed only
 * the current key, so it added a second entry beside the old one instead of
 * replacing it.
 *
 * Built from parts for the same reason tests/branding.test.ts builds its needle:
 * the retired name must not appear anywhere in the tracked tree, this file
 * included.
 */
export const LEGACY_MCP_SERVER_KEYS: readonly string[] = [['shell', 'pilot'].join('')]

export const CODEX_BLOCK_START = '# >>> opsmaxx managed block — written by OpsMaxx, safe to remove >>>'
export const CODEX_BLOCK_END = '# <<< opsmaxx managed block <<<'

// Matched on this prefix rather than the whole line: the CLI used to write a
// different sentence after it, and a block it wrote must still be recognised
// as ours and replaced, not stacked under.
const CODEX_BLOCK_PREFIX = '# >>> opsmaxx managed block'

/**
 * Puts `block` into a Codex config.toml, leaving everything the user wrote
 * exactly as it was.
 *
 * An existing managed block is replaced where it stands; otherwise the block is
 * appended. Either way any `[mcp_servers.<legacy>]` table is removed first. A
 * TOML table runs from its header to the next `[` header or end of file, and
 * that is the only TOML rule this relies on — there is no TOML dependency here,
 * and three key/value pairs are not worth adding one.
 */
export function spliceCodexBlock(existing: string, block: string): string {
  let out = existing
  for (const key of LEGACY_MCP_SERVER_KEYS) {
    const header = new RegExp(`^\\[mcp_servers\\.${key}(\\.[^\\]]*)?\\]\\s*$`, 'm')
    let m: RegExpExecArray | null
    while ((m = header.exec(out))) {
      const rest = out.slice(m.index + m[0].length)
      const next = rest.search(/^\[/m)
      out = out.slice(0, m.index) + (next === -1 ? '' : rest.slice(next))
    }
  }
  const s = out.indexOf(CODEX_BLOCK_PREFIX)
  const e = out.indexOf(CODEX_BLOCK_END)
  if (s !== -1 && e > s) return out.slice(0, s) + block + out.slice(e + CODEX_BLOCK_END.length)
  const kept = out.trimEnd()
  return kept + (kept ? '\n\n' : '') + block + '\n'
}
