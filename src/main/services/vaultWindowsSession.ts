import { app, safeStorage } from 'electron'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { VaultResult } from '../../shared/vault'
import { atomicWriteFileSync } from './atomicWrite'
import { vaultExportKey, vaultReopenSecured, vaultStatus, vaultUnlockWithKey } from './vault'

const profile = app.getPath('userData')
const preference = join(profile, 'opsmaxx-vault-windows-session.json')
const registryName = 'OpsMaxxVaultSession-' + createHash('sha256').update(resolve(profile).toLowerCase()).digest('hex')
let resumed = false

// The logon hive is unloaded on sign-out, including the sign-out that precedes
// a fast-startup shutdown. A volatile key below Volatile Environment also
// survives app exits without a resident helper or a vault key on disk.
function registry(operation: 'read' | 'write' | 'clear', input = ''): string {
  const key = `'${registryName}'`
  const commands = {
    read: `$sub = $parent.OpenSubKey(${key}); if ($null -ne $sub) { try { [Console]::Write($sub.GetValue('key', '')) } finally { $sub.Dispose() } }`,
    write: `$sub = $parent.CreateSubKey(${key}, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, [Microsoft.Win32.RegistryOptions]::Volatile); try { $sub.SetValue('key', [Console]::In.ReadToEnd()) } finally { $sub.Dispose() }`,
    clear: `$parent.DeleteSubKey(${key}, $false)`
  }
  const command =
    "$ErrorActionPreference = 'Stop'; " +
    `$parent = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Volatile Environment', ${operation === 'read' ? '$false' : '$true'}); ` +
    "if ($null -eq $parent) { throw 'Windows logon registry is unavailable' }; " +
    `try { ${commands[operation]} } finally { $parent.Dispose() }`
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    input,
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
    maxBuffer: 8192,
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

function readPreference(): { enabled: true; token?: string } | null {
  if (process.platform !== 'win32') return null
  try {
    const value = JSON.parse(readFileSync(preference, 'utf8'))
    return value?.enabled === true ? value : null
  } catch {
    return null
  }
}

export function vaultWindowsSessionStatus(): { enabled: boolean; canResume: boolean } | undefined {
  if (process.platform !== 'win32') return undefined
  const enabled = readPreference() !== null
  return { enabled, canResume: enabled && resumed && vaultStatus().stage === 'secured' }
}

export function setVaultWindowsSession(enabled: boolean): VaultResult {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows session unlock is unavailable.' }
  if (!enabled) {
    try {
      rmSync(preference, { force: true })
      resumed = false
      try { registry('clear') } catch { /* With no token the registry value cannot reopen the vault. */ }
      return { ok: true }
    } catch {
      return { ok: false, error: 'Could not turn off Windows session unlock.' }
    }
  }
  if (vaultStatus().stage !== 'open') return { ok: false, error: 'Unlock the vault first.' }
  const material = vaultExportKey()
  if (!material) return { ok: false, error: 'Unlock the vault first.' }
  try {
    const token = randomUUID()
    const wrapped = safeStorage.encryptString(JSON.stringify({
      token,
      key: material.key.toString('base64'),
      salt: material.salt.toString('base64')
    })).toString('base64')
    registry('write', wrapped)
    // Only a random revocation token is on disk. A failed write cannot enable
    // the new value even if PowerShell already stored it.
    atomicWriteFileSync(preference, JSON.stringify({ enabled: true, token }))
    resumed = true
    return { ok: true }
  } catch {
    return { ok: false, error: 'Could not store the vault key in this Windows session.' }
  } finally {
    material.key.fill(0)
  }
}

export function renewVaultWindowsSession(): void {
  if (readPreference()) setVaultWindowsSession(true)
}

export function restoreVaultWindowsSession(): void {
  resumed = false
  const token = readPreference()?.token
  if (!token || !vaultStatus().exists) return
  let key: Buffer | undefined
  try {
    const wrapped = registry('read').trim()
    if (!wrapped) return
    const value = JSON.parse(safeStorage.decryptString(Buffer.from(wrapped, 'base64')))
    if (value.token !== token || typeof value.key !== 'string' || typeof value.salt !== 'string') return
    key = Buffer.from(value.key, 'base64')
    const salt = Buffer.from(value.salt, 'base64')
    if (key.length === 32 && salt.length === 16) resumed = vaultUnlockWithKey(key, salt).ok
  } catch {
    // Normal password unlock remains available after a new logon or a failed restore.
  } finally {
    key?.fill(0)
  }
}

export function revokeVaultWindowsSession(): VaultResult {
  resumed = false
  if (!readPreference()?.token) return { ok: true }
  try {
    atomicWriteFileSync(preference, JSON.stringify({ enabled: true }))
  } catch {
    try {
      registry('clear')
    } catch {
      return { ok: false, error: 'Could not revoke Windows session unlock. Sign out of Windows to clear it.' }
    }
    return { ok: true }
  }
  try { registry('clear') } catch { /* The old token has already been revoked. */ }
  return { ok: true }
}

export function continueVaultWindowsSession(): VaultResult {
  if (!vaultWindowsSessionStatus()?.canResume) return { ok: false, error: 'Unlock with your master password.' }
  return vaultReopenSecured()
}
