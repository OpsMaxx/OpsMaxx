import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  RefreshCw,
  Terminal
} from 'lucide-react'

import { clsx } from '../../lib/format'
import {
  AWS_TRANSPORTS,
  CLOUD_PROVIDER_BINARY,
  CLOUD_PROVIDER_CLI_NAME,
  GCP_TRANSPORTS,
  type AwsTransport,
  type CloudProvider,
  type CloudTarget,
  type GcpTransport
} from '../../../../shared/cloud'
import {
  awsDescribeInstanceArgs,
  awsOpenTunnelArgs,
  awsSendPublicKeyArgs,
  azureSshConfigArgs,
  azureVmsArgs,
  gcpDescribeInstanceArgs,
  gcpIapTunnelArgs,
  gcpOsLoginAddKeyArgs,
  type CloudAccount,
  type CloudInstance,
  type CloudLocation
} from '../../../../shared/cloudCommands'

/**
 * The cloud half of the connection editor.
 *
 * Three providers, one shape: an account, a location, an instance. They are
 * called a project/zone/instance, a profile/region/instance and a
 * subscription/resource group/VM, and the labels below are the only place that
 * difference lives - everything else here is the same cascade.
 *
 * Each level is discovered from the provider's own CLI, and each is also
 * typeable: discovery needs permissions a connecting user does not necessarily
 * have (listing every project in an org is a different grant from reaching one
 * instance), so a failure to enumerate must never become a failure to connect.
 */

interface Labels {
  account: string
  location: string
  instance: string
  accountPlaceholder: string
  locationPlaceholder: string
  instancePlaceholder: string
}

// Keyed by provider rather than chosen with ternaries. The Add Database dialog
// records what ternaries cost there: two engines inherited each other's
// defaults because the condition was written once and read three times.
const LABELS: Record<CloudProvider, Labels> = {
  gcp: {
    account: 'Project',
    location: 'Zone',
    instance: 'Instance',
    accountPlaceholder: 'my-project-id',
    locationPlaceholder: 'me-central2-c',
    instancePlaceholder: 'prod-web-01'
  },
  aws: {
    account: 'Profile',
    location: 'Region',
    instance: 'Instance',
    accountPlaceholder: 'production',
    locationPlaceholder: 'me-central-1',
    instancePlaceholder: 'i-0123456789abcdef0'
  },
  azure: {
    account: 'Subscription',
    location: 'Resource group',
    instance: 'VM',
    accountPlaceholder: 'Production',
    locationPlaceholder: 'production-rg',
    instancePlaceholder: 'prod-server-01'
  }
}

export interface CloudDraft {
  account: string
  location: string
  instance: string
  osUser: string
  transport: string
}

export const emptyCloudDraft: CloudDraft = {
  account: '',
  location: '',
  instance: '',
  osUser: 'ubuntu',
  transport: 'auto'
}

/**
 * Turn what the form holds into a saved target, or null when it is incomplete.
 *
 * The single place the flat draft becomes the discriminated union, so the shape
 * the rest of the app sees cannot be assembled field-by-field somewhere else
 * and drift.
 */
export function draftToTarget(provider: CloudProvider, d: CloudDraft): CloudTarget | null {
  const account = d.account.trim()
  const location = d.location.trim()
  const instance = d.instance.trim()
  if (!account || !location || !instance) return null

  if (provider === 'gcp') {
    return {
      type: 'gcp',
      project: account,
      zone: location,
      instance,
      transport: (d.transport as GcpTransport) || 'auto'
    }
  }
  if (provider === 'aws') {
    const osUser = d.osUser.trim()
    if (!osUser) return null
    return {
      type: 'aws',
      profile: account,
      region: location,
      instanceId: instance,
      osUser,
      transport: (d.transport as AwsTransport) || 'auto'
    }
  }
  return {
    type: 'azure',
    subscription: account,
    resourceGroup: location,
    vm: instance,
    authentication: 'entra'
  }
}

export function targetToDraft(target: CloudTarget): CloudDraft {
  if (target.type === 'gcp') {
    return {
      account: target.project,
      location: target.zone,
      instance: target.instance,
      osUser: '',
      transport: target.transport
    }
  }
  if (target.type === 'aws') {
    return {
      account: target.profile,
      location: target.region,
      instance: target.instanceId,
      osUser: target.osUser,
      transport: target.transport
    }
  }
  return {
    account: target.subscription,
    location: target.resourceGroup,
    instance: target.vm,
    osUser: '',
    transport: 'auto'
  }
}

/** One discovery level: what was found, whether it is loading, and why not. */
interface Level<T> {
  items: T[]
  loading: boolean
  error: string
}

const emptyLevel = <T,>(): Level<T> => ({ items: [], loading: false, error: '' })

interface Detection {
  checked: boolean
  installed: boolean
  path: string
  version: string
  error: string
  authenticated: boolean
  account: string
}

const NOT_CHECKED: Detection = {
  checked: false,
  installed: false,
  path: '',
  version: '',
  error: '',
  authenticated: false,
  account: ''
}

export function CloudTargetFields({
  provider,
  draft,
  onChange
}: {
  provider: CloudProvider
  draft: CloudDraft
  onChange: (next: CloudDraft) => void
}): React.JSX.Element {
  const labels = LABELS[provider]
  const [detection, setDetection] = useState<Detection>(NOT_CHECKED)
  const [accounts, setAccounts] = useState<Level<CloudAccount>>(emptyLevel)
  const [locations, setLocations] = useState<Level<CloudLocation>>(emptyLevel)
  const [instances, setInstances] = useState<Level<CloudInstance>>(emptyLevel)

  const set = (patch: Partial<CloudDraft>): void => onChange({ ...draft, ...patch })

  /**
   * `force` is what "Check again" passes.
   *
   * Detection is cached for the life of the process so that opening this panel
   * does not shell out every time. That cache is exactly wrong for the one
   * button on this screen, whose entire purpose is "I have just installed it" -
   * without the flag it returned the same "not detected" forever.
   */
  const detect = useCallback(async (force = false): Promise<void> => {
    setDetection({ ...NOT_CHECKED, checked: false })
    const found = await window.opsmaxx?.cloud.detect(provider, force)
    if (!found || !found.ok) {
      setDetection({ ...NOT_CHECKED, checked: true, error: found?.error ?? 'Detection failed.' })
      return
    }
    const d = found.value
    if (!d.installed) {
      setDetection({
        ...NOT_CHECKED,
        checked: true,
        error: d.error ?? `${CLOUD_PROVIDER_CLI_NAME[provider]} was not detected.`
      })
      return
    }
    // Authentication is asked separately because "installed" and "signed in"
    // are different problems with different fixes, and collapsing them sends
    // the user to reinstall a tool that is already there.
    const auth = await window.opsmaxx?.cloud.authStatus(provider)
    setDetection({
      checked: true,
      installed: true,
      path: d.executablePath ?? '',
      version: d.version ?? '',
      error: '',
      authenticated: auth?.ok ? auth.value.authenticated : false,
      account: auth?.ok ? auth.value.account : ''
    })
  }, [provider])

  useEffect(() => {
    void detect()
  }, [detect])

  // Accounts, once the tool is usable.
  useEffect(() => {
    if (!detection.installed) return
    let cancelled = false
    setAccounts({ items: [], loading: true, error: '' })
    void (async () => {
      const res = await window.opsmaxx?.cloud.accounts(provider)
      if (cancelled) return
      setAccounts(
        res?.ok
          ? { items: res.value, loading: false, error: '' }
          : { items: [], loading: false, error: res?.error ?? 'Could not list them.' }
      )
    })()
    return () => {
      cancelled = true
    }
  }, [provider, detection.installed])

  useEffect(() => {
    if (!detection.installed || !draft.account.trim()) {
      setLocations(emptyLevel)
      return
    }
    let cancelled = false
    setLocations({ items: [], loading: true, error: '' })
    void (async () => {
      const res = await window.opsmaxx?.cloud.locations(provider, draft.account.trim())
      if (cancelled) return
      setLocations(
        res?.ok
          ? { items: res.value, loading: false, error: '' }
          : { items: [], loading: false, error: res?.error ?? 'Could not list them.' }
      )
    })()
    return () => {
      cancelled = true
    }
  }, [provider, detection.installed, draft.account])

  useEffect(() => {
    if (!detection.installed || !draft.account.trim() || !draft.location.trim()) {
      setInstances(emptyLevel)
      return
    }
    let cancelled = false
    setInstances({ items: [], loading: true, error: '' })
    void (async () => {
      const res = await window.opsmaxx?.cloud.instances(
        provider,
        draft.account.trim(),
        draft.location.trim()
      )
      if (cancelled) return
      setInstances(
        res?.ok
          ? { items: res.value, loading: false, error: '' }
          : { items: [], loading: false, error: res?.error ?? 'Could not list them.' }
      )
    })()
    return () => {
      cancelled = true
    }
  }, [provider, detection.installed, draft.account, draft.location])

  return (
    <>
      <CliStatus provider={provider} detection={detection} onRetry={() => void detect(true)} />

      {detection.installed && (
        <>
          <Picker
            label={labels.account}
            value={draft.account}
            placeholder={labels.accountPlaceholder}
            level={accounts}
            options={accounts.items.map((a) => ({ value: a.id, label: a.name }))}
            onChange={(v) => set({ account: v, location: '', instance: '' })}
          />

          <Picker
            label={labels.location}
            value={draft.location}
            placeholder={labels.locationPlaceholder}
            level={locations}
            options={locations.items.map((l) => ({ value: l.id, label: l.name }))}
            onChange={(v) => set({ location: v, instance: '' })}
            disabled={!draft.account.trim()}
          />

          <Picker
            label={labels.instance}
            value={draft.instance}
            placeholder={labels.instancePlaceholder}
            level={instances}
            options={instances.items.map((i) => ({
              value: i.id,
              // The state is shown rather than the row being hidden: a stopped
              // machine is one you may well want to save a connection for.
              label: i.name === i.id ? `${i.id} — ${i.state}` : `${i.name} (${i.id}) — ${i.state}`
            }))}
            onChange={(v) => set({ instance: v })}
            disabled={!draft.location.trim()}
          />

          {provider === 'aws' && (
            <div className="field">
              <label className="field-label" htmlFor="cloud-osuser">
                OS user
              </label>
              <input
                id="cloud-osuser"
                className="input"
                value={draft.osUser}
                placeholder="ubuntu"
                onChange={(e) => set({ osUser: e.target.value })}
              />
              <span className="field-hint">
                The account on the instance. EC2 Instance Connect publishes a key for this user for
                sixty seconds; nothing is stored.
              </span>
            </div>
          )}

          {provider !== 'azure' && (
            <div className="field">
              <label className="field-label" htmlFor="cloud-transport">
                Transport
              </label>
              <select
                id="cloud-transport"
                className="input"
                value={draft.transport}
                onChange={(e) => set({ transport: e.target.value })}
              >
                {(provider === 'gcp' ? GCP_TRANSPORTS : AWS_TRANSPORTS).map((t) => (
                  <option key={t} value={t}>
                    {TRANSPORT_LABEL[t]}
                  </option>
                ))}
              </select>
              <span className="field-hint">{TRANSPORT_HINT[provider]}</span>
            </div>
          )}

          {provider === 'azure' && (
            <div className="field">
              <label className="field-label">Authentication</label>
              <div className="field-hint">
                Microsoft Entra ID. Azure issues a short-lived certificate for each connection; no
                key is stored and access expires on its own.
              </div>
            </div>
          )}

          <CommandPreview provider={provider} draft={draft} />
        </>
      )}
    </>
  )
}

/**
 * Exactly what OpsMaxx will ask the provider CLI to do.
 *
 * Built by calling the same builders the connection itself calls, so the
 * preview cannot drift from what runs - a preview assembled from a template
 * string would be a second description of the command, and the two would
 * disagree the first time either changed.
 *
 * It shows the REAL invocations rather than the familiar `gcloud compute ssh`
 * one-liner. OpsMaxx does not run that: it asks the provider to broker a
 * tunnel and a short-lived credential and then connects itself, and printing a
 * command it never executes would be a plausible-looking lie in the one place
 * a user goes to find out what is actually happening.
 */
function CommandPreview({
  provider,
  draft
}: {
  provider: CloudProvider
  draft: CloudDraft
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const target = draftToTarget(provider, draft)
  if (!target) return null

  let lines: string[][]
  try {
    lines = previewCommands(target)
  } catch {
    // A value that fails the argv guards has nothing honest to preview.
    return null
  }
  const binary = CLOUD_PROVIDER_BINARY[provider]
  const text = lines.map((argv) => `${binary} ${argv.join(' ')}`).join('\n')

  return (
    <div className="field">
      <button type="button" className="disclosure" onClick={() => setOpen(!open)}>
        <ChevronRight size={12} className={clsx('disclosure-chevron', open && 'open')} />
        What OpsMaxx will run
      </button>
      {open && (
        <>
          <pre className="field-hint" style={{ whiteSpace: 'pre-wrap', userSelect: 'text' }}>
            {text}
          </pre>
          <span className="field-hint">
            Run with your own {CLOUD_PROVIDER_CLI_NAME[provider]}, as you. OpsMaxx connects to what
            these hand back; it never runs an SSH client of its own.
          </span>
          <button
            type="button"
            className="btn size-28"
            onClick={() => void navigator.clipboard?.writeText(text)}
          >
            <Copy size={12} /> Copy
          </button>
        </>
      )}
    </div>
  )
}

/** The commands a connection actually issues, in order, for this target. */
function previewCommands(target: CloudTarget): string[][] {
  if (target.type === 'gcp') {
    return [
      gcpDescribeInstanceArgs(target),
      gcpOsLoginAddKeyArgs(target.project, '<temporary public key>', 300),
      ...(target.transport === 'direct' ? [] : [gcpIapTunnelArgs(target)])
    ]
  }
  if (target.type === 'aws') {
    return [
      awsDescribeInstanceArgs(target),
      ...(target.transport === 'ip' ? [] : [awsOpenTunnelArgs(target, 0)]),
      awsSendPublicKeyArgs(target, '<temporary public key>')
    ]
  }
  return [
    azureVmsArgs(target.subscription, target.resourceGroup),
    azureSshConfigArgs(target, '<temporary directory>/config')
  ]
}

const TRANSPORT_LABEL: Record<string, string> = {
  auto: 'Auto',
  direct: 'Direct',
  iap: 'IAP tunnel',
  ip: 'Public or private IP',
  eice: 'EC2 Instance Connect Endpoint'
}

const TRANSPORT_HINT: Record<CloudProvider, string> = {
  gcp: 'Auto tunnels through IAP when the instance has no external address.',
  aws: 'Auto uses an EC2 Instance Connect Endpoint when there is no public address.',
  azure: ''
}

/**
 * A combo of a list and a text box.
 *
 * Not a bare `<select>`: discovery can fail for reasons that have nothing to do
 * with whether the user can reach the machine - listing every project in an
 * organisation is a broader permission than connecting to one instance in it.
 * A form that only offers what it managed to enumerate would lock those users
 * out of their own servers.
 *
 * TYPABLE EVEN WHEN THE LIST LOADED, which it was not. This used to be two
 * mutually exclusive branches: a `<select>` when discovery returned anything
 * and a text box only when it returned nothing. An organisation with a
 * thousand projects therefore got a scrolling menu and no way to search it,
 * and the user's own report is what found it. So the field is always an input
 * and the list is an extra affordance beside it.
 *
 * An explicit button rather than a `<datalist>`, following LogTailPanel, which
 * tried the datalist first and recorded why it came back off: its arrow is a
 * few pixels wide and it needs the field focused, so an operator typed the
 * whole name by hand while the list sat unopened.
 *
 * Filtering matches the id AND the display name, because they differ for every
 * provider here — a GCP project is `my-project-284401` called "Billing", and
 * the user knows whichever one they know.
 */
function Picker({
  label,
  value,
  placeholder,
  level,
  options,
  onChange,
  disabled
}: {
  label: string
  value: string
  placeholder: string
  level: Level<unknown>
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  disabled?: boolean
}): React.JSX.Element {
  const id = `cloud-${label.toLowerCase().replace(/\s+/g, '-')}`
  const [picking, setPicking] = useState(false)

  // Capped, like the log tail's picker: past a couple of hundred rows the list
  // stops being something you read and the typing is what narrows it.
  const shown = useMemo(() => {
    const q = value.trim().toLowerCase()
    const matches =
      q === ''
        ? options
        : options.filter(
            (o) => o.value.toLowerCase().includes(q) || o.label.toLowerCase().includes(q)
          )
    return matches.slice(0, 200)
  }, [options, value])

  // The field holds the id, because that is what the form submits. So when the
  // id alone says nothing, the name it belongs to is shown under it.
  const chosen = options.find((o) => o.value === value)

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="cloud-pick-row">
        <input
          id={id}
          className="input"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            onChange(e.target.value)
            if (options.length > 0) setPicking(true)
          }}
        />
        {options.length > 0 && (
          <button
            type="button"
            className="btn ghost sm"
            title={`Pick from ${options.length}`}
            disabled={disabled}
            aria-expanded={picking}
            onClick={() => setPicking((v) => !v)}
          >
            <ChevronDown size={13} />
          </button>
        )}
      </div>
      {picking && !disabled && options.length > 0 && (
        <div className="cloud-pick">
          {shown.length === 0 ? (
            <div className="faint" style={{ padding: '6px 10px' }}>
              Nothing matches what you have typed. It is still a valid {label.toLowerCase()} if
              you know it — the list is only what we could enumerate.
            </div>
          ) : (
            shown.map((o) => (
              <button
                type="button"
                key={o.value}
                className="cloud-pick-one"
                onClick={() => {
                  onChange(o.value)
                  setPicking(false)
                }}
              >
                <span>{o.label}</span>
                {o.label !== o.value && <span className="faint mono">{o.value}</span>}
              </button>
            ))
          )}
          {options.length > shown.length && (
            <div className="faint" style={{ padding: '4px 10px' }}>
              {shown.length} of {options.length} — keep typing to narrow.
            </div>
          )}
        </div>
      )}
      {chosen && chosen.label !== value && <span className="field-hint">{chosen.label}</span>}
      {level.loading && (
        <span className="field-hint">
          <Loader2 size={11} className="spin" /> Looking…
        </span>
      )}
      {!level.loading && level.error && (
        <span className="field-hint">
          {level.error} You can still type the {label.toLowerCase()} in.
        </span>
      )}
    </div>
  )
}

/**
 * What OpsMaxx found on this machine, and whether it is signed in.
 *
 * The path and version are shown because this is the one screen that can say
 * exactly which binary is about to be executed on the user's behalf, and a
 * product that runs someone else's tooling owes them that.
 */
function CliStatus({
  provider,
  detection,
  onRetry
}: {
  provider: CloudProvider
  detection: Detection
  onRetry: () => void
}): React.JSX.Element {
  const name = CLOUD_PROVIDER_CLI_NAME[provider]

  if (!detection.checked) {
    return (
      <div className="field">
        <span className="field-hint">
          <Loader2 size={11} className="spin" /> Looking for {name}…
        </span>
      </div>
    )
  }

  if (!detection.installed) {
    return (
      <div className="field">
        <span className="field-hint danger">
          <AlertTriangle size={11} /> {detection.error || `${name} was not detected.`}
        </span>
        <span className="field-hint">
          OpsMaxx uses the {name} you already have installed, and never installs one itself. Install
          it, sign in, then check again.
        </span>
        <button type="button" className="btn size-28" onClick={onRetry}>
          <RefreshCw size={12} /> Check again
        </button>
      </div>
    )
  }

  return (
    <div className="field">
      <span className="field-hint ok">
        <CheckCircle2 size={11} /> {name} {detection.version}
      </span>
      <span className="field-hint">
        <Terminal size={11} /> {detection.path}
      </span>
      {detection.authenticated ? (
        <span className="field-hint ok">Signed in as {detection.account}</span>
      ) : (
        <span className="field-hint danger">
          <AlertTriangle size={11} /> Not signed in. Sign in with {name}, then check again.
        </span>
      )}
    </div>
  )
}
