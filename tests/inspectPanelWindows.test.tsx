// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { envLines, listeningMessage } from '../src/renderer/src/components/inspect/InspectView'

/**
 * Two sentences in the Traffic panel that were wrong on Windows.
 *
 * Both were found from the same report — a Windows user whose terminal
 * captured nothing — and both are the panel telling somebody something untrue
 * while they stare at a request count of zero.
 */

describe('what the empty flow list claims while capture is running', () => {
  // It said this for EVERY source. On "Nothing automatically" and on "This
  // whole machine" it is simply false, and it is the one sentence a user
  // reads when they are trying to work out why nothing appeared.
  it('promises automatic terminal routing only on the source that does it', () => {
    expect(listeningMessage('sessions')).toContain('routed through the inspector')
    expect(listeningMessage('system')).not.toContain('routed through the inspector')
    expect(listeningMessage('manual')).not.toContain('routed through the inspector')
  })

  // A shell inherits its environment once, at spawn. Terminals that were
  // already open are not routed and cannot be made routed, so the sentence
  // that promises routing has to name the exclusion in the same breath.
  it('names the terminals that are NOT routed', () => {
    expect(listeningMessage('sessions')).toContain('already open are not')
  })
})

describe('the lines “Copy shell setup” puts on the clipboard', () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:58653', NODE_EXTRA_CA_CERTS: 'C:\\ca.crt' }

  // `export FOO=bar` is not a syntax error in PowerShell — `export` is just an
  // unrecognised command name — so the user gets a wall of "not recognized as
  // the name of a cmdlet" and a shell still pointed at nothing. PowerShell is
  // the shell this app itself offers as the Windows default.
  it('are PowerShell assignments on Windows, not POSIX exports', () => {
    const lines = envLines(env, 'win32')
    expect(lines).not.toContain('export ')
    expect(lines).toContain('$env:HTTPS_PROXY = "http://127.0.0.1:58653"')
    expect(lines).toContain('$env:NODE_EXTRA_CA_CERTS = "C:\\ca.crt"')
  })

  it('are still exports everywhere else, including for a remote session', () => {
    expect(envLines(env, 'darwin')).toContain('export HTTPS_PROXY=http://127.0.0.1:58653')
    expect(envLines(env, 'linux')).toContain('export NODE_EXTRA_CA_CERTS=C:\\ca.crt')
  })
})
