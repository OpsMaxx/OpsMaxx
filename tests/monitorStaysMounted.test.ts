import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Leaving the monitor and coming back must not be a reset.
 *
 * Reported against 0.50.21: read the containers on a host in Docker, switch to
 * a terminal, come back, and the list is empty until Refresh is pressed again.
 * The same on Kubernetes. Neither panel had lost anything — both had been
 * unmounted and rebuilt, and their selection and their reads are component
 * state.
 *
 * The unmount was one line in App.tsx: `{activity === 'monitor' &&
 * <FleetMonitor />}`. Docker, Kubernetes, CI/CD and local processes are
 * separate activity-bar destinations whose panels are all mounted inside that
 * one tree, so the line tore down four destinations' worth of state on any
 * trip to another icon.
 *
 * It was never only a forgotten list. LogTailPanel stops its remote command on
 * unmount and BroadcastPanel holds a live fan-out in component state — which
 * FleetMonitor's own comment says, about the rail split one level below where
 * the unmounting actually was.
 *
 * Asserted against the source rather than by driving the app, on the precedent
 * of tests/httpClientAffordances.test.ts: what is being pinned is a mounting
 * decision, which is a property of this file and of nothing a rendered tree
 * would show. Comments are stripped first, so the paragraph above cannot be
 * what satisfies the check.
 */

const strip = (p: string): string =>
  readFileSync(resolve(__dirname, '..', p), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

const APP = strip('src/renderer/src/App.tsx')
const MONITOR = strip('src/renderer/src/components/monitor/FleetMonitor.tsx')

describe('the monitor tree', () => {
  it('is not unmounted when another destination is shown', () => {
    expect(APP).not.toMatch(/activity === 'monitor' && <FleetMonitor/)
  })

  it('is mounted once visited and then only hidden', () => {
    // The HTTP client's pattern, and for the same reason: not built at startup
    // by someone who never opens it, never torn down once it holds something.
    expect(APP).toMatch(/monitorVisited\.current = true/)
    expect(APP).toMatch(/\{monitorVisited\.current && <FleetMonitor hidden=\{!onMonitor\} \/>\}/)
  })

  it('hides every one of its render paths, not just the one', () => {
    // Three: the empty state it returns early, the monitor rail, and the
    // operations rail. A `hidden` that reached two of them would leave the
    // monitor drawn over whatever the user actually switched to.
    expect(MONITOR).toMatch(/hidden \? \{ display: 'none' \} : undefined/)
    expect(MONITOR).toMatch(/hidden \|\| rail === 'operations' \? \{ display: 'none' \} : undefined/)
    expect(MONITOR).toMatch(/hidden=\{hidden \|\| rail !== 'operations'\}/)
  })
})
