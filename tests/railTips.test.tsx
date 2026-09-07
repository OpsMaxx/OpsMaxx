// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

import { FeatureTipCard } from '../src/renderer/src/components/onboarding/FeatureTipCard'
import { useApp } from '../src/renderer/src/store/app'
import { useNav } from '../src/renderer/src/store/nav'
import { useOnboarding } from '../src/renderer/src/store/onboarding'

// Monitoring and Operations are two rail destinations sharing ONE ActivityView.
// That is deliberate: they are one mounted tree, and a split that unmounted
// either would kill a running log tail or strand a live fan-out.
//
// The cost is that `activity` alone cannot tell them apart — and anything keyed
// on it will treat the user as being somewhere they are not. Found in the
// shipped 0.22.0 build: standing in Operations, the app offered the tip that
// begins "Monitoring, including what is broken", explaining a screen that was
// not on the display.

beforeEach(() => {
  useOnboarding.setState({ seenTips: [], open: false })
  useApp.setState({ activity: 'monitor' } as never)
  useNav.setState({ fleetRail: 'monitor' })
})

describe('a tip belongs to a rail, not just to a view', () => {
  it('offers the monitoring tip on the Monitoring rail', () => {
    render(<FeatureTipCard />)
    expect(screen.queryByText(/Monitoring, including what is broken/)).not.toBeNull()
  })

  // THE regression. Same ActivityView, different destination.
  it('offers nothing on the Operations rail', () => {
    useNav.setState({ fleetRail: 'operations' })
    render(<FeatureTipCard />)
    expect(screen.queryByText(/Monitoring, including what is broken/)).toBeNull()
  })

  // Crossing back must still work: the tip is deferred, not spent, so somebody
  // who passed through Operations first has not silently lost it.
  it('still offers it after a trip through Operations and back', () => {
    useNav.setState({ fleetRail: 'operations' })
    const { rerender } = render(<FeatureTipCard />)
    expect(screen.queryByText(/Monitoring, including what is broken/)).toBeNull()
    useNav.setState({ fleetRail: 'monitor' })
    rerender(<FeatureTipCard />)
    expect(screen.queryByText(/Monitoring, including what is broken/)).not.toBeNull()
  })

  // The rail check must apply only where the view is shared. A tip on an
  // unshared view has no rail to match and would otherwise vanish.
  it('leaves tips on unshared views alone', () => {
    useApp.setState({ activity: 'vault' } as never)
    useNav.setState({ fleetRail: 'operations' })
    render(<FeatureTipCard />)
    expect(screen.queryByText(/The vault is where credentials live/)).not.toBeNull()
  })
})
