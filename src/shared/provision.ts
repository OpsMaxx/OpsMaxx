/**
 * The hot-device manifest: what a fresh machine needs in order to become one
 * of yours.
 *
 * DESIGNED IN FULL, IMPLEMENTED IN PART, and the split is deliberate. v1
 * restores OpsMaxx's own state and runs one user-written hook. The broader
 * thing people mean by provisioning -- package managers, runtimes, dotfiles --
 * is per-OS driver work that is Ansible plus nix-darwin plus chezmoi in one
 * row, and it gets its own sizing pass rather than a guess now.
 *
 * What the format has to do TODAY is make that later work additive. So the
 * sections below exist with their shapes settled even where nothing reads them
 * yet, and a manifest that names a section this build does not implement is
 * REPORTED rather than ignored -- an unimplemented section silently skipped is
 * a machine somebody believes is provisioned.
 */

/** Bumped only when an older build could misread a newer manifest. Adding a
 *  section does not bump it: an unknown section is already reported. */
export const PROVISION_MANIFEST_VERSION = 1

export interface ProvisionManifest {
  version: number
  /** Free text, shown before anything runs. The author is telling the operator
   *  what this machine is for. */
  description?: string
  /** Restore OpsMaxx's own state from a backup. The only section v1 applies
   *  besides the hook. */
  opsmaxx?: OpsMaxxSection
  /** One script, run after the restore. See `PostRestoreHook` for why this is
   *  the most dangerous field in the file. */
  postRestore?: PostRestoreHook
  /**
   * DESIGNED, NOT IMPLEMENTED. Each is a per-OS driver and each is reported as
   * unimplemented rather than skipped.
   *
   * They are here so that adding one later is a new implementation against an
   * existing shape rather than a manifest format change -- which would mean
   * every manifest anybody wrote becoming a manifest an older build refuses.
   */
  packages?: PackageSection
  runtimes?: RuntimeSection
  dotfiles?: DotfilesSection
}

export interface OpsMaxxSection {
  /** Where the backup bundle is. A path on this machine, or an addy
   *  generation name. Never a URL: fetching a bundle from an address in a
   *  manifest is a way to make somebody restore a bundle they did not choose. */
  bundle: { kind: 'file'; path: string } | { kind: 'addy'; generation: string }
  /** Whether to keep what is already here. Default false, because a fresh
   *  machine is the case this is for and merging two estates silently is the
   *  case nobody wants. */
  merge?: boolean
}

/**
 * A script run after the restore.
 *
 * THE MOST DANGEROUS FIELD IN THIS FORMAT, and the reason the whole thing is
 * preview-then-apply. A manifest is a file: it arrives by email, from a
 * colleague, out of a repository. A hook that ran automatically would mean
 * anyone who can hand somebody a manifest can run code on their machine as
 * them -- which is not a provisioning feature, it is a delivery mechanism.
 *
 * So: the script is SHOWN IN FULL and confirmed separately from the restore,
 * every time, with no remembered consent and no "always allow". The
 * interpreter is named by the manifest and checked against a short list,
 * because "run this with whatever the shebang says" is the same hole with an
 * extra step.
 */
export interface PostRestoreHook {
  /** `bash`, `sh`, `pwsh` or `powershell`. Not a path, and not taken from a
   *  shebang. */
  interpreter: 'bash' | 'sh' | 'pwsh' | 'powershell'
  /** The script itself, inline. NOT a path or a URL: a manifest that pointed
   *  at a file would be a manifest whose shown contents and executed contents
   *  are two different things. */
  script: string
  /** Shown above the script. What the author says it does -- which the
   *  operator reads alongside what it actually does. */
  describes?: string
}

/** Designed, not implemented. */
export interface PackageSection {
  /** `brew`, `apt`, `winget`, … The manager decides the driver. */
  manager: string
  install: string[]
}

/** Designed, not implemented. */
export interface RuntimeSection {
  /** `node`, `go`, `python`, … mapped to a version. */
  versions: Record<string, string>
}

/** Designed, not implemented. */
export interface DotfilesSection {
  repository: string
  /** Where to put them. Relative to the home directory, always. */
  target?: string
}

/** What `previewProvision` reports before anything happens. */
export interface ProvisionPlan {
  description?: string
  steps: ProvisionStep[]
  /** Sections this build does not implement, named. An unimplemented section
   *  silently skipped is a machine somebody believes is provisioned. */
  unsupported: { section: string; reason: string }[]
  problems: string[]
}

export interface ProvisionStep {
  kind: 'restore' | 'hook'
  summary: string
  /** For a hook: the script, in full, exactly as it will be run. */
  detail?: string
}

/** The sections this build can actually apply. Everything else in the manifest
 *  is reported as unimplemented, by name. */
export const IMPLEMENTED_SECTIONS = ['opsmaxx', 'postRestore'] as const

const WHY_NOT: Record<string, string> = {
  packages:
    'installing packages is a per-OS driver -- brew, apt and winget disagree about almost everything -- and it has not been built yet.',
  runtimes:
    'installing language runtimes means a version manager per language, which has not been built yet.',
  dotfiles:
    'cloning and linking dotfiles means deciding what to do about files that already exist, which has not been designed yet.'
}

/**
 * Reads a manifest and says what would happen.
 *
 * Pure, so the dangerous half -- deciding what to run -- can be tested without
 * a machine to run it on.
 */
export function planProvision(manifest: unknown): ProvisionPlan {
  const plan: ProvisionPlan = { steps: [], unsupported: [], problems: [] }

  if (typeof manifest !== 'object' || manifest === null) {
    plan.problems.push('That is not a provisioning manifest.')
    return plan
  }
  const m = manifest as Partial<ProvisionManifest> & Record<string, unknown>

  if (typeof m.version !== 'number') {
    plan.problems.push('The manifest does not say which version of the format it is.')
    return plan
  }
  if (m.version > PROVISION_MANIFEST_VERSION) {
    // Refused, not attempted. A newer manifest may mean something different by
    // a field this build thinks it understands, and guessing on a machine
    // somebody is setting up is the worst place to guess.
    plan.problems.push(
      `That manifest is version ${m.version} and this build understands ${PROVISION_MANIFEST_VERSION}. Upgrade OpsMaxx.`
    )
    return plan
  }

  plan.description = typeof m.description === 'string' ? m.description : undefined

  if (m.opsmaxx) {
    const bundle = m.opsmaxx.bundle
    if (!bundle || typeof bundle !== 'object') {
      plan.problems.push('The opsmaxx section names no backup to restore from.')
    } else if (bundle.kind === 'file') {
      plan.steps.push({
        kind: 'restore',
        summary: `Restore this machine's OpsMaxx data from ${bundle.path}${m.opsmaxx.merge ? ', keeping what is already here' : ', replacing what is already here'}`
      })
    } else if (bundle.kind === 'addy') {
      plan.steps.push({
        kind: 'restore',
        summary: `Restore from the addy generation ${bundle.generation}${m.opsmaxx.merge ? ', keeping what is already here' : ', replacing what is already here'}`
      })
    } else {
      plan.problems.push(`The opsmaxx section names a backup of an unknown kind.`)
    }
  }

  if (m.postRestore) {
    const hook = m.postRestore
    if (!['bash', 'sh', 'pwsh', 'powershell'].includes(hook.interpreter)) {
      // Not "run it with the default shell". An interpreter this build does
      // not know is a script it cannot honestly describe before running.
      plan.problems.push(
        `The hook asks for the interpreter "${String(hook.interpreter)}", which is not one of bash, sh, pwsh or powershell.`
      )
    } else if (typeof hook.script !== 'string' || hook.script.trim() === '') {
      plan.problems.push('The hook has no script.')
    } else {
      plan.steps.push({
        kind: 'hook',
        summary: hook.describes
          ? `Run a ${hook.interpreter} script: ${hook.describes}`
          : `Run a ${hook.interpreter} script the manifest does not describe`,
        // In full, exactly as it will be run. A summary here would be a
        // summary somebody approves instead of the script.
        detail: hook.script
      })
    }
  }

  for (const section of Object.keys(m)) {
    if (section === 'version' || section === 'description') continue
    if ((IMPLEMENTED_SECTIONS as readonly string[]).includes(section)) continue
    plan.unsupported.push({
      section,
      reason: WHY_NOT[section] ?? 'this build does not know what that section means.'
    })
  }

  if (plan.steps.length === 0 && plan.problems.length === 0) {
    plan.problems.push('That manifest asks for nothing this build can do.')
  }
  return plan
}
