// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { AddServerModal } from '../src/renderer/src/components/connections/AddServerModal'
import { useApp } from '../src/renderer/src/store/app'
import { MAX_TAGS, MAX_TAG_LENGTH, normalizeTags, parseTags } from '../src/renderer/src/lib/serverTags'
import { distroIcon } from '../src/renderer/src/lib/distroIcon'

/**
 * Host tags, written from the server dialog.
 *
 * `Server.tags` has existed, and been searched, since the tree was written, and
 * the only thing that ever wrote one was the ssh_config import. The dialog now
 * edits them, through the same add and update paths as every other field.
 */

beforeEach(() => {
  stubBridge({
    ssh: { defaultKeys: () => Promise.resolve([]) },
    secrets: { set: () => Promise.resolve(true), get: () => Promise.resolve(null), delete: () => Promise.resolve() }
  })
})

const tagsField = (): HTMLInputElement => screen.getByLabelText('Tags') as HTMLInputElement
const confirm = (): HTMLButtonElement => {
  const buttons = document.querySelectorAll('.modal-footer button')
  return buttons[buttons.length - 1] as HTMLButtonElement
}

describe('normalising tags', () => {
  it('trims, lowercases, dedupes and drops empties', () => {
    expect(parseTags(' Prod, prod ,, EU-West ,')).toEqual(['prod', 'eu-west'])
  })

  it('caps the length of a tag and the number of tags', () => {
    expect(normalizeTags(['x'.repeat(100)])[0]).toHaveLength(MAX_TAG_LENGTH)
    expect(normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(MAX_TAGS)
  })
})

describe('the server dialog', () => {
  it('adds, edits and removes tags through the store', async () => {
    const u = userEvent.setup()
    const { unmount } = render(<AddServerModal />)
    await u.type(screen.getByPlaceholderText('Production API'), 'web')
    await u.type(screen.getByPlaceholderText('10.20.0.10'), '10.0.0.5')
    await u.click(screen.getByText('SSH Agent'))
    await u.type(tagsField(), 'Prod, EU')
    await u.click(confirm())
    const added = useApp.getState().servers.find((s) => s.name === 'web')!
    expect(added.tags).toEqual(['prod', 'eu'])
    unmount()

    // Edit: the saved tags come back into the field, and a change replaces them.
    useApp.setState({ editServerId: added.id, modal: 'add-server' } as never)
    const second = render(<AddServerModal />)
    expect(tagsField().value).toBe('prod, eu')
    await u.clear(tagsField())
    await u.type(tagsField(), 'eu, db')
    await u.click(confirm())
    expect(useApp.getState().servers.find((s) => s.id === added.id)!.tags).toEqual(['eu', 'db'])
    second.unmount()

    // Remove: an empty field is no tags, not the previous ones.
    useApp.setState({ editServerId: added.id, modal: 'add-server' } as never)
    render(<AddServerModal />)
    await u.clear(tagsField())
    await u.click(confirm())
    expect(useApp.getState().servers.find((s) => s.id === added.id)!.tags).toEqual([])
  })
})

describe('the distro icon allowlist', () => {
  it('knows the common distributions', () => {
    expect(distroIcon('ubuntu')?.label).toBe('Ubuntu')
    expect(distroIcon('rocky')?.label).toBe('Rocky Linux')
  })

  it.each([
    'other',
    'Ubuntu',
    'windows',
    '',
    '__proto__',
    'constructor',
    'toString',
    '../../etc/passwd',
    'ubuntu" onerror="x',
    null,
    undefined,
    42,
    { toString: () => 'ubuntu' }
  ])('draws nothing for %j', (value) => {
    expect(distroIcon(value)).toBeNull()
  })
})
