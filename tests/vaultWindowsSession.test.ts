import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { vaultCreate, vaultDestroy, vaultDispose, vaultSecure, vaultStatus, vaultUnlock } from '../src/main/services/vault'
import {
  continueVaultWindowsSession,
  renewVaultWindowsSession,
  restoreVaultWindowsSession,
  revokeVaultWindowsSession,
  setVaultWindowsSession,
  vaultWindowsSessionStatus
} from '../src/main/services/vaultWindowsSession'

afterEach(() => {
  if (process.platform === 'win32') setVaultWindowsSession(false)
  vaultDestroy()
})

it.skipIf(process.platform !== 'win32')('remembers across app exits and expires after sign-out or manual lock', async () => {
  const password = 'test-only master password'
  expect((await vaultCreate(password)).ok).toBe(true)
  expect(setVaultWindowsSession(true).ok).toBe(true)
  const profile = app.getPath('userData')
  const preference = JSON.parse(readFileSync(join(profile, 'opsmaxx-vault-windows-session.json'), 'utf8'))
  expect(preference).toEqual({ enabled: true, token: expect.any(String) })

  vaultDispose()
  expect(vaultStatus().stage).toBe('locked')
  restoreVaultWindowsSession()
  expect(vaultStatus().stage).toBe('open')
  vaultSecure()
  expect(vaultWindowsSessionStatus()?.canResume).toBe(true)
  expect(continueVaultWindowsSession().ok).toBe(true)

  // Simulate Windows dropping the volatile key at sign-out. The disk
  // preference stays as it would on the next sign-in.
  const id = createHash('sha256').update(resolve(profile).toLowerCase()).digest('hex')
  const reg = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
  execFileSync(reg, ['delete', `HKCU\\Volatile Environment\\OpsMaxxVaultSession-${id}`, '/f'], { windowsHide: true })
  vaultDispose()
  restoreVaultWindowsSession()
  expect(vaultStatus().stage).toBe('locked')
  expect(vaultWindowsSessionStatus()?.enabled).toBe(true)
  expect(continueVaultWindowsSession().ok).toBe(false)

  expect((await vaultUnlock(password)).ok).toBe(true)
  renewVaultWindowsSession()
  expect(revokeVaultWindowsSession().ok).toBe(true)
  vaultDispose()
  restoreVaultWindowsSession()
  expect(vaultStatus().stage).toBe('locked')
})
