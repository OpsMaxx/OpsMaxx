// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { RequestPane } from '../src/renderer/src/components/http/RequestPane'
import type { ApiCollection, ApiEndpoint } from '../src/renderer/src/types'
import type { HttpRequestSpec } from '../src/shared/httpClient'

/**
 * The HTTP client, rendered rather than read.
 *
 * Three separate reports said the same thing about the screen this replaces:
 * there was no way to send a request, picking a method changed nothing, and
 * clicking an operation populated nothing. All three were invisible to a
 * source-level check — the old pane rendered, it just never did anything — so
 * this drives the component and asserts on the spec that reaches the bridge.
 */

const collection = (over: Partial<ApiCollection> = {}): ApiCollection => ({
  id: 'col-1',
  workspaceId: 'ws-default',
  name: 'Weather',
  specUrl: null,
  specPath: null,
  baseUrl: 'https://api.example.test',
  viaServerId: null,
  insecureTls: false,
  endpoints: [],
  ...over
})

const endpoint = (over: Partial<ApiEndpoint> = {}): ApiEndpoint => ({
  id: 'ep-1',
  method: 'get',
  path: '/data/2.5/weather',
  ...over
})

/** A bridge whose `request` records the spec and answers with a real body. */
function recordingBridge(): { specs: HttpRequestSpec[] } {
  const specs: HttpRequestSpec[] = []
  const request = vi.fn(async (spec: HttpRequestSpec) => {
    specs.push(spec)
    return {
      ok: true as const,
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode('{"temp":11}').buffer as ArrayBuffer,
      durationMs: 42.4,
      truncated: false
    }
  })
  stubBridge({ http: { request } })
  return { specs }
}

const bodyOf = (spec: HttpRequestSpec): string =>
  spec.body ? new TextDecoder().decode(new Uint8Array(spec.body)) : ''

describe('sending a request', () => {
  it('sends one, and shows what came back', async () => {
    const { specs } = recordingBridge()
    const user = userEvent.setup()
    render(<RequestPane collection={collection()} endpoint={endpoint()} />)

    // The Send button is the whole of the first report. It has to exist, and
    // pressing it has to reach the transport.
    await user.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => expect(specs).toHaveLength(1))
    expect(specs[0].url).toBe('https://api.example.test/data/2.5/weather')
    expect(specs[0].method).toBe('GET')

    // The status, the duration and the body, because a response nobody can
    // read is the same as no response.
    expect(await screen.findByText(/200 OK/)).toBeTruthy()
    expect(screen.getByText(/42 ms/)).toBeTruthy()
    expect(screen.getByText(/"temp": 11/)).toBeTruthy()
  })

  it('loads the endpoint it was given, not a blank request', () => {
    recordingBridge()
    render(
      <RequestPane collection={collection()} endpoint={endpoint({ method: 'post', path: '/x' })} />
    )
    expect((screen.getByLabelText('Method') as HTMLSelectElement).value).toBe('POST')
    expect((screen.getByLabelText('Path') as HTMLInputElement).value).toBe('/x')
  })

  it('replaces the request when a different endpoint is selected', async () => {
    recordingBridge()
    const { rerender } = render(
      <RequestPane collection={collection()} endpoint={endpoint({ id: 'ep-1', path: '/one' })} />
    )
    expect((screen.getByLabelText('Path') as HTMLInputElement).value).toBe('/one')

    // The bug behind "nothing is being populated upon clicking everything".
    rerender(
      <RequestPane
        collection={collection()}
        endpoint={endpoint({ id: 'ep-2', method: 'delete', path: '/two' })}
      />
    )
    expect((screen.getByLabelText('Path') as HTMLInputElement).value).toBe('/two')
    expect((screen.getByLabelText('Method') as HTMLSelectElement).value).toBe('DELETE')
  })
})

describe('what the request carries', () => {
  it('appends enabled params to the URL and skips disabled ones', async () => {
    const { specs } = recordingBridge()
    const user = userEvent.setup()
    render(<RequestPane collection={collection()} endpoint={endpoint()} />)

    await user.click(screen.getByRole('button', { name: /add row/i }))
    await user.type(screen.getByLabelText('Name'), 'q')
    await user.type(screen.getByLabelText('Value'), 'london')

    await user.click(screen.getByRole('button', { name: /add row/i }))
    const names = screen.getAllByLabelText('Name')
    await user.type(names[1], 'units')
    await user.type(screen.getAllByLabelText('Value')[1], 'metric')
    // Off rather than removed: the row stays, the parameter does not travel.
    await user.click(screen.getByRole('checkbox', { name: /send units/i }))

    await user.click(screen.getByRole('button', { name: /^send$/i }))
    await waitFor(() => expect(specs).toHaveLength(1))
    expect(specs[0].url).toBe('https://api.example.test/data/2.5/weather?q=london')
  })

  it('sends a body on POST and infers its content type', async () => {
    const { specs } = recordingBridge()
    const user = userEvent.setup()
    render(<RequestPane collection={collection()} endpoint={endpoint({ method: 'post' })} />)

    await user.click(screen.getByRole('button', { name: /^body$/i }))
    await user.type(screen.getByLabelText('Body'), '{{"name":"x"}')
    await user.click(screen.getByRole('button', { name: /^send$/i }))

    await waitFor(() => expect(specs).toHaveLength(1))
    expect(bodyOf(specs[0])).toBe('{"name":"x"}')
    expect(specs[0].headers['Content-Type']).toBe('application/json')
  })

  it('lets an explicit content type win over the guess', async () => {
    const { specs } = recordingBridge()
    const user = userEvent.setup()
    render(<RequestPane collection={collection()} endpoint={endpoint({ method: 'post' })} />)

    await user.click(screen.getByRole('button', { name: /^body$/i }))
    await user.type(screen.getByLabelText('Body'), 'a=1')
    await user.click(screen.getByRole('button', { name: /headers/i }))
    await user.click(screen.getByRole('button', { name: /add row/i }))
    await user.type(screen.getByLabelText('Name'), 'content-type')
    await user.type(screen.getByLabelText('Value'), 'application/x-www-form-urlencoded')

    await user.click(screen.getByRole('button', { name: /^send$/i }))
    await waitFor(() => expect(specs).toHaveLength(1))
    expect(specs[0].headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(specs[0].headers['Content-Type']).toBeUndefined()
  })

  it('says why a GET keeps its body instead of hiding the field', async () => {
    recordingBridge()
    const user = userEvent.setup()
    render(<RequestPane collection={collection()} endpoint={endpoint()} />)
    await user.click(screen.getByRole('button', { name: /^body$/i }))
    // A disabled control with no explanation is the defect this screen was
    // reported for; the text has to name the method and the way out.
    expect(screen.getByText(/GET carries no body/i)).toBeTruthy()
  })

  it('carries the collection certificate setting through to the transport', async () => {
    const { specs } = recordingBridge()
    const user = userEvent.setup()
    render(
      <RequestPane collection={collection({ insecureTls: true })} endpoint={endpoint()} />
    )
    await user.click(screen.getByRole('button', { name: /^send$/i }))
    await waitFor(() => expect(specs).toHaveLength(1))
    expect(specs[0].insecureTls).toBe(true)
    expect(specs[0].via).toEqual({ kind: 'direct' })
  })
})

describe('when it cannot be sent', () => {
  it('refuses rather than falling back to a direct request', async () => {
    const { specs } = recordingBridge()
    // The named server is gone. Sending directly would reach a DIFFERENT
    // machine — commonly a public one sharing the name of something internal.
    render(
      <RequestPane collection={collection({ viaServerId: 'srv-gone' })} endpoint={endpoint()} />
    )
    const send = screen.getByRole('button', { name: /^send$/i }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    expect(screen.getByText(/no longer exists/i)).toBeTruthy()
    expect(specs).toHaveLength(0)
  })

  it('reports a transport failure in the response area', async () => {
    stubBridge({
      http: {
        request: vi.fn(async () => ({ ok: false as const, error: 'connect ECONNREFUSED', code: 'ECONNREFUSED' }))
      }
    })
    const user = userEvent.setup()
    render(<RequestPane collection={collection()} endpoint={endpoint()} />)
    await user.click(screen.getByRole('button', { name: /^send$/i }))
    expect(await screen.findByText(/connect ECONNREFUSED/)).toBeTruthy()
    expect(screen.getByText('ECONNREFUSED')).toBeTruthy()
  })

  it('does not throw when the preload bridge predates this pane', async () => {
    stubBridge({})
    const user = userEvent.setup()
    render(<RequestPane collection={collection()} endpoint={endpoint()} />)
    await user.click(screen.getByRole('button', { name: /^send$/i }))
    expect(await screen.findByText(/Restart OpsMaxx to send/i)).toBeTruthy()
  })
})
