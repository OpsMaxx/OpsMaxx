// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { SshPrompt } from '../src/renderer/src/components/connections/SshPrompt'
import type { SshPromptRequest } from '../src/preload/index'

/**
 * Two second factors at once, which is ordinary and was unhandled.
 *
 * The component kept ONE request and replaced it whenever another arrived.
 * Nothing answered the one that was dropped, so main's own 120-second fallback
 * answered it instead — with `[]`, an empty and therefore WRONG second factor —
 * and the connection behind it died with "the challenge was not answered in
 * time", which is the failure the tester reported.
 *
 * Restoring a session set opens several servers together and a jump chain asks
 * once per hop, so "one at a time" was never the shape of this.
 */

let deliver: (req: SshPromptRequest) => void = () => undefined
const replyPrompt = vi.fn()

const challenge = (id: string, host: string, prompt = 'Verification code:'): SshPromptRequest =>
  ({
    id,
    host,
    username: 'ali',
    serverId: `srv-${id}`,
    name: 'Two-factor',
    instructions: '',
    prompts: [{ prompt, echo: false }]
  }) as SshPromptRequest

beforeEach(() => {
  replyPrompt.mockClear()
  stubBridge({
    ssh: {
      onPrompt: (cb: (req: SshPromptRequest) => void) => {
        deliver = cb
        return () => undefined
      },
      replyPrompt
    }
  })
})

const codeBox = (): HTMLInputElement =>
  document.querySelector('.modal input.input') as HTMLInputElement

describe('a second challenge arriving while the first is unanswered', () => {
  it('does not replace the one on screen', async () => {
    render(<SshPrompt />)
    deliver(challenge('kb-1', 'jump-auth'))
    deliver(challenge('kb-2', 'other-host'))

    expect(await screen.findByText('ali@jump-auth')).toBeTruthy()
    expect(screen.queryByText('ali@other-host')).toBeNull()
  })

  it('says another one is behind it', async () => {
    render(<SshPrompt />)
    deliver(challenge('kb-1', 'jump-auth'))
    deliver(challenge('kb-2', 'other-host'))
    expect(await screen.findByText(/One more server is waiting/)).toBeTruthy()
  })

  it('shows it once the first is answered, and answers both', async () => {
    render(<SshPrompt />)
    deliver(challenge('kb-1', 'jump-auth'))
    deliver(challenge('kb-2', 'other-host'))

    await screen.findByText('ali@jump-auth')
    await userEvent.type(codeBox(), '111111')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('ali@other-host')).toBeTruthy()
    // A fresh field, not the digits typed for the previous host.
    expect(codeBox().value).toBe('')

    await userEvent.type(codeBox(), '222222')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(replyPrompt.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['kb-1', ['111111']],
      ['kb-2', ['222222']]
    ])
  })

  // The bug in one line: the dropped challenge was answered by a timer, with
  // an empty answer, which is what spends a MaxAuthTries slot.
  it('never answers the one that was merely waiting', async () => {
    render(<SshPrompt />)
    deliver(challenge('kb-1', 'jump-auth'))
    deliver(challenge('kb-2', 'other-host'))
    await screen.findByText('ali@jump-auth')

    expect(replyPrompt).not.toHaveBeenCalled()
  })

  it('cancelling the first still leaves the second to be answered', async () => {
    render(<SshPrompt />)
    deliver(challenge('kb-1', 'jump-auth'))
    deliver(challenge('kb-2', 'other-host'))
    await screen.findByText('ali@jump-auth')

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(replyPrompt).toHaveBeenCalledExactlyOnceWith('kb-1', [])
    expect(await screen.findByText('ali@other-host')).toBeTruthy()
  })
})

describe('remembering an answer', () => {
  /**
   * An ALLOW-LIST, and the direction is the whole point.
   *
   * A remembered answer is replayed with no dialog at all, so remembering a
   * one-time code makes a server quietly stop asking and start refusing. The
   * switch used to be offered for anything a list of known wordings failed to
   * recognise, which is the wrong default for a guess: a PAM module that simply
   * prompts `Password:` for a TOTP is on no such list.
   */
  it('is offered for a prompt that says it is a password', async () => {
    render(<SshPrompt />)
    deliver(challenge('kb-1', 'jump-auth', 'Password:'))
    expect(await screen.findByText(/Remember this answer/)).toBeTruthy()
  })

  it('is not offered for a verification code', async () => {
    render(<SshPrompt />)
    deliver(challenge('kb-1', 'jump-auth', 'Verification code:'))
    await screen.findByText('ali@jump-auth')
    expect(screen.queryByText(/Remember this answer/)).toBeNull()
  })

  // The case the deny-list let through: wording it simply did not know.
  it('is not offered for a challenge that names itself nothing at all', async () => {
    render(<SshPrompt />)
    deliver(challenge('kb-1', 'jump-auth', 'Enter response:'))
    await screen.findByText('ali@jump-auth')
    expect(screen.queryByText(/Remember this answer/)).toBeNull()
  })

  it('is not offered for "One-time password", which reads as both', async () => {
    render(<SshPrompt />)
    deliver(challenge('kb-1', 'jump-auth', 'One-time password:'))
    await screen.findByText('ali@jump-auth')
    expect(screen.queryByText(/Remember this answer/)).toBeNull()
  })
})

describe('the dialog itself', () => {
  // Closing REPLIES to the server, so a reflex Escape must not be able to do
  // it. See tests/modalStack.test.tsx for the primitive this relies on.
  it('cannot be dismissed by Escape or a click outside it', async () => {
    render(<SshPrompt />)
    deliver(challenge('kb-1', 'jump-auth'))
    await screen.findByText('ali@jump-auth')

    await userEvent.keyboard('{Escape}')
    await userEvent.click(document.body)

    expect(replyPrompt).not.toHaveBeenCalled()
    expect(screen.getByText('ali@jump-auth')).toBeTruthy()
  })
})
