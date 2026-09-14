import { describe, it, expect } from 'vitest'
import { mayOpenExternally } from '../src/shared/externalUrl'

// `setWindowOpenHandler` turns every `window.open` in the renderer into
// `shell.openExternal`, and that is an OS-level open: the platform picks a
// handler by scheme and runs it. This is the check in front of it.

describe('what may reach the operating system', () => {
  it('allows the web and the contact address, which is everything the app opens', () => {
    for (const url of [
      'https://github.com/OpsMaxx/OpsMaxx/issues/new?template=bug_report.yml',
      'http://localhost:8080/',
      'mailto:someone@example.com'
    ])
      expect(mayOpenExternally(url), url).toBe(true)
  })

  it('refuses everything else', () => {
    for (const url of [
      // Opens a local path in the platform's file handler.
      'file:///etc/passwd',
      'file://///attacker.example/share/x.lnk',
      // Windows resolves a long tail of registered schemes, and more than one
      // of these has been an exploit primitive.
      'ms-msdt:/id PCWDiagnostic',
      'search-ms:query=x&crumb=location:\\\\attacker.example\\share',
      'ms-officecmd:{}',
      'smb://attacker.example/share',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)'
    ])
      expect(mayOpenExternally(url), url).toBe(false)
  })

  it('refuses anything that is not a URL at all', () => {
    for (const s of ['', 'not a url', '//host/path', 'C:\\Windows\\System32\\calc.exe'])
      expect(mayOpenExternally(s), s).toBe(false)
  })
})
