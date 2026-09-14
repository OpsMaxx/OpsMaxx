/**
 * Running a provider CLI.
 *
 * One rule: an argument array, never a command string. There is no shell on
 * this path, so nothing is quoted, nothing is word-split, and no identifier a
 * user or an agent supplied can become syntax. `shell: true` does not appear in
 * this file and must not be added to it - see the Windows note below for the
 * one place that is genuinely awkward, and what is done instead.
 *
 * This module IS reachable from the MCP bridge, deliberately, because cloud
 * servers are addressable by agents. That is a widening of the rule
 * tests/localTerminalNotExposed.test.ts enforces, and it is why the validators
 * in shared/cloud.ts exist and why every builder refuses an option-shaped
 * value. Nothing here accepts a command: the only things that reach `execFile`
 * are argv arrays built by the builders in shared/cloudCommands.ts.
 */

import { execFile } from 'node:child_process'

import {
  CloudError,
  CLOUD_PROVIDER_CLI_NAME,
  type CloudProvider
} from '../../../shared/cloud'
import { classifyCloudOutput } from '../../../shared/cloudCommands'
import { redactOutput } from '../secretRedaction'
import { detectProvider } from './binaries'

export interface CloudExecResult {
  /** True when the command ran and exited zero. */
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
}

/** Long enough for a cold `gcloud` to load Python, short enough to not hang. */
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Characters cmd.exe would treat as syntax.
 *
 * Only consulted on Windows, and only for a `.cmd`/`.bat` entry point. Node
 * refuses to spawn those without a shell (the fix for CVE-2024-27980), and both
 * `gcloud` and `az` ship as `.cmd` wrappers - so on Windows the choice is
 * between not supporting them and going through `cmd.exe`. We go through
 * `cmd.exe` with an argv array and refuse anything cmd could reinterpret.
 *
 * A DENY list, not an allow list, and that is a correction rather than a
 * preference. The allow list this replaced permitted `%` - which cmd expands,
 * so `%PATH%` in an identifier would have been substituted - while forbidding
 * spaces, which are ordinary in the Windows paths we generate ourselves: the
 * temporary public key GCP needs lands under `C:\Users\<name>\AppData\...`,
 * and a user whose name contains a space met a hard failure whose message
 * talked about Azure subscriptions. Node quotes an argument containing spaces;
 * it cannot save one containing `&` or `%`.
 */
const WINDOWS_UNSAFE_ARG = /[&|<>^"%!]/

function needsCmdWrapper(file: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)
}

/**
 * Run one provider command.
 *
 * Never throws for an ordinary non-zero exit - that is a result, and the caller
 * usually wants to classify it. It DOES throw when the tool is absent, or when
 * an argument could not be passed safely, because neither is something a caller
 * should have to remember to check.
 */
export async function cloudExec(
  provider: CloudProvider,
  args: string[],
  options: { timeoutMs?: number } = {}
): Promise<CloudExecResult> {
  const detected = await detectProvider(provider)
  if (!detected.installed || !detected.executablePath) {
    throw new CloudError('cli-not-installed', detected.error, { provider })
  }

  let file = detected.executablePath
  let argv = args

  if (needsCmdWrapper(file)) {
    for (const arg of args) {
      if (WINDOWS_UNSAFE_ARG.test(arg)) {
        throw new CloudError(
          'invalid-identifier',
          `On Windows a value containing & | < > ^ " % or ! cannot be passed to the provider ` +
            `tool safely, and this one does. If it is an Azure subscription name, use its ID instead.`,
          { provider }
        )
      }
    }
    argv = ['/c', file, ...args]
    file = process.env.COMSPEC ?? 'cmd.exe'
  }

  return await new Promise<CloudExecResult>((resolve) => {
    execFile(
      file,
      argv,
      {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
        // Instance lists on a large account are genuinely big.
        maxBuffer: 32 * 1024 * 1024,
        // Inherit the user's environment: that is where their cloud session
        // lives. We add nothing and remove nothing - OpsMaxx is consuming an
        // already-authenticated environment, not constructing one.
        env: process.env
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? ((err as { code: number }).code)
            : err
              ? null
              : 0
        resolve({
          ok: !err,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code
        })
      }
    )
  })
}

/**
 * Run a command and insist it succeeded, turning a failure into a CloudFault.
 *
 * The provider's own text is carried in `detail` for the person-facing
 * message and the details drawer. It is redacted first: these tools print
 * bearer tokens in their debug output, and this string can reach a log.
 */
export async function cloudExecOrThrow(
  provider: CloudProvider,
  args: string[],
  options: { timeoutMs?: number } = {}
): Promise<string> {
  const result = await cloudExec(provider, args, options)
  if (result.ok) return result.stdout

  const combined = `${result.stderr}\n${result.stdout}`.trim()
  const fault = classifyCloudOutput(combined, provider) ?? 'cli-failed'
  throw new CloudError(fault, firstLine(redactOutput(combined)), { provider })
}

/** The one line of a failure worth showing, or a fallback naming the tool. */
function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return ''
}

/** Named so the absent-tool message can say which tool. */
export function cliName(provider: CloudProvider): string {
  return CLOUD_PROVIDER_CLI_NAME[provider]
}
