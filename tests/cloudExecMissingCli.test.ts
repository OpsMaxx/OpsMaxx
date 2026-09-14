import { describe, it, expect, vi, beforeEach } from 'vitest'

import { CloudError } from '../src/shared/cloud'

// "The tool is not installed" cannot be asserted by pointing detection at an
// empty directory and hoping. Detection also looks in the documented install
// locations and, on POSIX, on PATH -- so on any machine that genuinely has a
// provider CLI it will correctly find one, and the assertion fails for a reason
// that has nothing to do with the code. That is exactly how this escaped
// review: it passed on a laptop with no gcloud and failed on a CI runner that
// ships the Google Cloud SDK.
//
// So detection is stubbed and the contract under test is cloudExec's alone:
// when nothing was found, it throws a typed fault rather than spawning
// something or returning a result that looks like a failed command.

const detectProvider = vi.fn()

vi.mock('../src/main/services/cloud/binaries', () => ({
  detectProvider,
  resetCloudBinaryCache: vi.fn(),
  checkExecutable: vi.fn()
}))

const { cloudExec, cloudExecOrThrow } = await import('../src/main/services/cloud/cloudExec')

beforeEach(() => {
  detectProvider.mockReset()
})

describe('when the provider CLI is not installed', () => {
  it('throws cli-not-installed rather than spawning anything', async () => {
    detectProvider.mockResolvedValue({
      installed: false,
      supported: false,
      error: 'Google Cloud CLI was not detected.'
    })

    await expect(cloudExec('gcp', ['compute', 'instances', 'list'])).rejects.toBeInstanceOf(
      CloudError
    )
    try {
      await cloudExec('gcp', ['compute', 'instances', 'list'])
    } catch (e) {
      expect((e as CloudError).fault).toBe('cli-not-installed')
      // The detection message is carried through: "not detected" and "found but
      // refused because it sits in a world-writable directory" are different
      // problems, and the second one is invisible if only the fault survives.
      expect((e as CloudError).detail).toMatch(/not detected/)
      expect((e as CloudError).provider).toBe('gcp')
    }
  })

  it('throws the same way through cloudExecOrThrow', async () => {
    detectProvider.mockResolvedValue({ installed: false, supported: false, error: 'absent' })
    await expect(cloudExecOrThrow('aws', ['ec2', 'describe-instances'])).rejects.toBeInstanceOf(
      CloudError
    )
  })

  it('throws when detection returns no path, even if it claims to be installed', async () => {
    // A defensive branch worth pinning: `installed: true` with no
    // executablePath would otherwise reach execFile with undefined.
    detectProvider.mockResolvedValue({ installed: true, supported: true })
    try {
      await cloudExec('azure', ['account', 'show'])
      throw new Error('expected a throw')
    } catch (e) {
      expect(e).toBeInstanceOf(CloudError)
      expect((e as CloudError).fault).toBe('cli-not-installed')
    }
  })
})
