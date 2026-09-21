import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// "This button still opens the details at the bottom of all pods."
//
// a17c1aa7 fixed exactly this for the logs button, and dfddbbff did the same
// for Docker container logs. Diagnose and exec were never migrated: both
// rendered near the foot of the panel — after the pods list, the workloads,
// usage and resources views, the node list and four dialogs — so pressing them
// changed nothing the eye could see. On a cluster with a screenful of pods that
// is indistinguishable from a dead button, which is how both were reported.
//
// A source-shape test because the alternative is mounting the panel against a
// stubbed kubectl bridge to assert DOM ordering, which is a great deal of
// machinery to pin "this JSX is inside that loop".

const SRC = readFileSync(
  resolve(__dirname, '..', 'src/renderer/src/components/kubernetes/KubernetesPanel.tsx'),
  'utf8'
)

/** Everything from the pod-row Fragment to the end of the pods list. */
function rowBlock(): string {
  const start = SRC.indexOf('<Fragment key={key}>')
  expect(start, 'the pod row Fragment moved; this test is reading the wrong place').toBeGreaterThan(0)
  return SRC.slice(start, SRC.indexOf('</Fragment>', start))
}

describe('a pod row owns what its buttons open', () => {
  it('renders the logs pane inside the row', () => {
    expect(rowBlock()).toMatch(/<LogPane/)
  })

  it('renders the diagnosis inside the row', () => {
    expect(rowBlock()).toMatch(/<DiagPane/)
  })

  it('renders the exec card inside the row', () => {
    expect(rowBlock()).toMatch(/execFor\?\.name === p\.name/)
  })

  it('renders the exec RESULT inside the row too', () => {
    // It landed below the card, which was itself below everything else.
    expect(rowBlock()).toMatch(/execResult\?\.pod === p\.name/)
  })
})

describe('what is left at the foot of the panel', () => {
  it('is only the pane the user explicitly popped out', () => {
    // The one deliberate exception, and it is opt-in: `poppedOut` is set by a
    // Pop out button, never by opening something.
    const foot = SRC.slice(SRC.lastIndexOf('</Fragment>'))
    expect(foot).toMatch(/poppedOut && logs\[poppedOut\]/)
    expect(foot).not.toMatch(/<DiagPane/)
    expect(foot).not.toMatch(/\{execFor && \(/)
  })
})

describe('the buttons say what they will do', () => {
  it('diagnose advertises that it toggles, like the logs button beside it', () => {
    expect(SRC).toMatch(/aria-expanded=\{!!diag\[key\]\}/)
  })

  it('exec keeps its explanation reachable while disabled', () => {
    // Chromium does not dispatch mouse events to a disabled control, so a
    // `title` on the button itself never fires — and that title is the only
    // thing saying WHY it is disabled. It has to sit on a wrapper.
    const btn = SRC.slice(SRC.indexOf('THE TITLE IS ON THE SPAN'))
    expect(btn.slice(0, 1200)).toMatch(/<span\s+title=\{/)
  })
})
