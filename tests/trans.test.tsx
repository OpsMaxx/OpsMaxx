// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Trans } from '../src/renderer/src/lib/Trans'
import type { MessageKey } from '../src/shared/i18n'

// Keys that are not in en.json fall through to the key itself, which makes the
// key the message: a way to test the tag handling without a fixture pack.
const k = (s: string): MessageKey => s as MessageKey

describe('Trans', () => {
  it('renders named tags with the element the call site supplies', () => {
    const { container } = render(<Trans i18nKey={k('Press <b>Ctrl +</b> now')} components={{ b: <b /> }} />)
    expect(container.innerHTML).toBe('Press <b>Ctrl +</b> now')
  })

  it('renders a tag the call site did not name as its plain text, never as markup', () => {
    const { container } = render(<Trans i18nKey={k('<script>alert(1)</script> and <img/>')} />)
    expect(container.innerHTML).toBe('alert(1) and &lt;img/&gt;')
  })

  it('handles self-closing tags and values', () => {
    const { container } = render(
      <Trans i18nKey={k('One<br/>{{n}} more')} values={{ n: 2 }} components={{ br: <br /> }} />
    )
    expect(container.innerHTML).toBe('One<br>2 more')
  })
})
