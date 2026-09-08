import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  TIMER_MARKERS,
  buildTimerDetailCommand,
  buildTimerListCommand,
  describeAge,
  parseTimerDetail,
  parseTimerList,
  parseUnitShow,
  renewalTimers,
  timerHealth,
  validateUnitName,
  type TimerRow
} from '../src/shared/systemdTimers'

// Item 46's certbot row, generalised to systemd timers because that is what
// could be measured: the test host runs no certbot, but it runs eleven timers,
// three that have never fired, and two genuinely failed services.
//
// Everything here comes from that host (Ubuntu 24.04.4, systemd 255) through
// the commands this module builds.

const fx = (n: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/host/timers/${n}`, import.meta.url)), 'utf8')

const LIST = fx('list-ubuntu-2404.txt').replace(TIMER_MARKERS.list, '')
const rows = (): TimerRow[] => parseTimerList(LIST)

describe('the list, off the real host', () => {
  it('reads every timer including the ones that will never fire', () => {
    const r = rows()
    expect(r.length).toBeGreaterThan(8)
    expect(r.map((x) => x.unit)).toContain('logrotate.timer')
    expect(r.map((x) => x.unit)).toContain('ua-timer.timer')
  })

  // FINDING 4. Three timers on the host report `last: 0` and `next: null`.
  // Zero fed to a date renders as 1970, i.e. "56 years ago" -- the most
  // alarming possible way to say "this has never run".
  it('reads last:0 as never rather than as 1970', () => {
    const ua = rows().find((r) => r.unit === 'ua-timer.timer')!
    expect(LIST).toContain('"last":0')
    expect(ua.lastMs).toBeNull()
    expect(ua.nextMs).toBeNull()
  })

  it('reads a real last run as a real epoch', () => {
    const lr = rows().find((r) => r.unit === 'logrotate.timer')!
    expect(lr.lastMs).not.toBeNull()
    // 2020s, not 1970 and not the far future.
    expect(lr.lastMs!).toBeGreaterThan(Date.UTC(2020, 0, 1))
    expect(lr.nextMs).not.toBeNull()
  })

  // FINDING 2. `left` is the SAME absolute stamp as `next`. Rendering it as a
  // remaining time gives about fifty-six thousand years.
  it('never uses `left`, which is an absolute stamp and not a duration', () => {
    const parsed = JSON.parse(LIST.trim()) as { next: number | null; left: number | null }[]
    const withNext = parsed.find((e) => e.next !== null)!
    expect(withNext.left).toBe(withNext.next)
    const src = readFileSync(
      fileURLToPath(new URL('../src/shared/systemdTimers.ts', import.meta.url)),
      'utf8'
    )
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    expect(src).not.toMatch(/\be\.left\b/)
  })

  // FINDING 3. `passed` is a monotonic stamp: the host's uptime was 1132793 s
  // and logrotate reported 1088423 s. Subtracting it from now dates every timer
  // to the 1970s.
  it('never uses `passed`, which is time since boot', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/shared/systemdTimers.ts', import.meta.url)),
      'utf8'
    )
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    expect(src).not.toMatch(/\be\.passed\b/)
  })

  it('ignores output that is not the JSON it asked for', () => {
    expect(parseTimerList('Failed to list units: Access denied')).toEqual([])
    expect(parseTimerList('')).toEqual([])
    expect(parseTimerList('{"not":"an array"}')).toEqual([])
  })
})

describe('a unit that is not installed', () => {
  const d = parseTimerDetail(fx('detail-absent.txt'))

  // FINDING 1, and the fixture that justifies the whole design: EVERY field
  // says fine.
  it('reports success for a unit the host does not have', () => {
    expect(d.timer.Result).toBe('success')
    expect(d.service.Result).toBe('success')
    expect(d.service.ExecMainStatus).toBe('0')
    expect(d.timer.ActiveState).toBe('inactive')
    expect(d.timer.SubState).toBe('dead')
    // Only this one disagrees.
    expect(d.timer.LoadState).toBe('not-found')
  })

  it('is called absent, not healthy, and says why the success is meaningless', () => {
    const h = timerHealth({ ...d, nowMs: Date.now() })
    expect(h.verdict).toBe('absent')
    expect(h.detail).toContain('not installed')
    expect(h.detail).toContain('not the same as a job that worked')
  })
})

describe('a timer that is installed but stopped', () => {
  const d = parseTimerDetail(fx('detail-never-run.txt'))

  // FINDING 5: `inactive` on a TIMER means it will never fire. The same word on
  // a service means a oneshot finished.
  it('says it will not fire, rather than reading its service as fine', () => {
    expect(d.timer.LoadState).toBe('loaded')
    expect(d.timer.ActiveState).toBe('inactive')
    expect(d.service.Result).toBe('success')
    const h = timerHealth({ ...d, nowMs: Date.now() })
    expect(h.verdict).toBe('inactive')
    expect(h.detail).toContain('will not fire')
  })
})

describe('a timer whose service fails', () => {
  const d = parseTimerDetail(fx('detail-service-failed.txt'))

  // THE point of reading the service at all. `logrotate.timer` is active and
  // firing daily; `cloud-init.service` last ended `exit-code`, status 1.
  it('is failing even though the timer itself is perfectly healthy', () => {
    expect(d.timer.ActiveState).toBe('active')
    expect(d.service.ActiveState).toBe('failed')
    expect(d.service.Result).toBe('exit-code')
    const h = timerHealth({ ...d, nowMs: Date.now() })
    expect(h.verdict).toBe('failing')
    expect(h.detail).toContain('exit-code')
    expect(h.detail).toContain('exit 1')
    expect(h.detail).toContain('not a job that is getting done')
  })
})

describe('a healthy timer', () => {
  const d = parseTimerDetail(fx('detail-healthy.txt'))

  it('is only called ok once the load, the timer and the service all agree', () => {
    const row = rows().find((r) => r.unit === 'logrotate.timer')!
    const h = timerHealth({ ...d, row, nowMs: row.lastMs! + 3 * 3600_000 })
    expect(h.verdict).toBe('ok')
    expect(h.detail).toContain('3 hour(s) ago')
    expect(h.lastRunMs).toBe(row.lastMs)
  })

  // Active, loaded, service fine, but it has never actually run.
  it('separates never-run from ok', () => {
    const h = timerHealth({
      timer: { Id: 'x.timer', LoadState: 'loaded', ActiveState: 'active' },
      service: { Id: 'x.service', LoadState: 'loaded', Result: 'success' },
      nowMs: Date.now()
    })
    expect(h.verdict).toBe('never-run')
    expect(h.detail).toContain('never run')
  })

  // A timer firing into a service that does not exist fails every run.
  it('calls a missing service a failure, not an absence', () => {
    const h = timerHealth({
      timer: { Id: 'x.timer', LoadState: 'loaded', ActiveState: 'active' },
      service: { Id: 'x.service', LoadState: 'not-found' },
      nowMs: Date.now()
    })
    expect(h.verdict).toBe('failing')
    expect(h.detail).toContain('nothing to start')
  })

  it('says unknown when the timer could not be read at all', () => {
    const h = timerHealth({ timer: {}, service: {}, nowMs: Date.now() })
    expect(h.verdict).toBe('unknown')
  })
})

describe('ages', () => {
  it('rounds to something a person reads', () => {
    expect(describeAge(30_000)).toBe('30 second(s) ago')
    expect(describeAge(3 * 3600_000)).toBe('3 hour(s) ago')
    expect(describeAge(5 * 24 * 3600_000)).toBe('5 day(s) ago')
  })

  // A negative age means a clock moved, not that something runs in the future.
  it('does not report a negative age as an age', () => {
    expect(describeAge(-5000)).toContain('clock moved')
  })
})

describe('the commands', () => {
  it('asks for every timer, in JSON, without escalating', () => {
    const c = buildTimerListCommand()
    expect(c).toContain('list-timers --all -o json')
    expect(c).not.toContain('sudo')
  })

  it('asks both units for LoadState, which is what finding 1 needs', () => {
    const c = buildTimerDetailCommand('certbot.timer', 'certbot.service')
    expect(c.match(/-p LoadState/g)).toHaveLength(2)
    expect(c).toContain('systemctl show certbot.timer')
    expect(c).toContain('systemctl show certbot.service')
  })

  // These names are interpolated into a shell command.
  it('refuses a unit name that is not one', () => {
    for (const bad of ['a; rm -rf /', 'foo', 'foo.socket', '', '../x.service', 'a b.timer']) {
      expect(validateUnitName(bad), bad).toBe(false)
      expect(() => buildTimerDetailCommand(bad, 'x.service')).toThrow()
    }
    expect(validateUnitName('snap.certbot.renew.timer')).toBe(true)
    expect(validateUnitName('logrotate.service')).toBe(true)
  })
})

describe('finding a renewal timer', () => {
  // NOT MEASURED: the test host runs no certbot. This is a filter over data the
  // host listed rather than a parser, so an unrecognised name produces a MISS
  // and never a wrong answer about a different unit.
  it('matches on the units the host actually reported', () => {
    const list: TimerRow[] = [
      { unit: 'certbot.timer', activates: 'certbot.service', nextMs: 1, lastMs: 1 },
      { unit: 'snap.certbot.renew.timer', activates: 'x.service', nextMs: 1, lastMs: 1 },
      { unit: 'logrotate.timer', activates: 'logrotate.service', nextMs: 1, lastMs: 1 }
    ]
    expect(renewalTimers(list).map((r) => r.unit)).toEqual([
      'certbot.timer',
      'snap.certbot.renew.timer'
    ])
  })

  it('finds none on a host that has none, rather than guessing', () => {
    expect(renewalTimers(rows())).toEqual([])
  })
})

describe('parsing show output', () => {
  it('keeps a value that contains an equals sign', () => {
    expect(parseUnitShow('Environment=FOO=bar\nId=x.service')).toEqual({
      Environment: 'FOO=bar',
      Id: 'x.service'
    })
  })

  it('ignores a line that is not a property', () => {
    expect(parseUnitShow('Failed to get properties\nId=x.service')).toEqual({ Id: 'x.service' })
  })

  // A line beginning with `=` has no key. Keeping it puts an empty-string
  // property in the record, which every lookup then has to not match by luck.
  it('ignores a line with no key before the equals', () => {
    expect(parseUnitShow('=orphaned\nId=x.service')).toEqual({ Id: 'x.service' })
  })
})

describe('the wiring', () => {
  const code = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')

  it('is asked for per timer rather than added to the hourly sweep', () => {
    expect(code('../src/main/index.ts')).toContain("ipcMain.handle('fleet:timer'")
    const svc = code('../src/main/services/hostFacts.ts')
    expect(svc).toContain('async timer(')
    expect(svc).toContain("return { error: r.error ?? 'could not reach the server' }")
  })

  // The names reach a shell command. A name that is not one is refused in main,
  // not escaped, and not trusted because the renderer sent it.
  it('refuses a bad unit name in main rather than escaping it', () => {
    const svc = code('../src/main/services/hostFacts.ts')
    expect(svc).toContain('buildTimerDetailCommand(timerUnit, serviceUnit)')
    expect(svc).toContain("return { error: 'that is not a systemd unit name' }")
  })

  // Reading only the timer answers "is it scheduled" when the question is
  // "is it working".
  it('reads the service as well as the timer', () => {
    const pre = code('../src/preload/index.ts')
    expect(pre).toContain("ipcRenderer.invoke('fleet:timer', cfg, timerUnit, serviceUnit)")
  })

  it('offers the button only on a systemd timer, where there is a unit to ask about', () => {
    const panel = code('../src/renderer/src/components/monitor/CronPanel.tsx')
    expect(panel).toContain("e.kind === 'systemd-timer' && (")
    expect(panel).toContain('loadTimerHealth(h.serverId, e.origin)')
  })

  // A failed READ is not a verdict and must not render like one.
  it('renders a failed read as an alarm rather than as a health answer', () => {
    const panel = code('../src/renderer/src/components/monitor/CronPanel.tsx')
    expect(panel).toContain('timerHealthState.error !== undefined ||')
    expect(panel).toContain("? 'panel-note is-alarm'")
  })

  // An `ok` verdict is the only one that is not an alarm.
  it('treats every verdict except ok as something to look at', () => {
    const panel = code('../src/renderer/src/components/monitor/CronPanel.tsx')
    expect(panel).toContain("timerHealthState.health.verdict !== 'ok'")
  })
})
