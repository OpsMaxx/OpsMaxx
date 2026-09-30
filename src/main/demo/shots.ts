import type { Page, Shot } from './capture'
import { raiseDemoApproval } from './seed'

/**
 * The site's screenshots, in the order the capture walks them.
 *
 * Everything is found the way a person finds it -- by the words on screen --
 * so a restyle does not break the walk; a renamed button does, and says which.
 */

/** Click an activity-bar section by the start of its label. */
async function section(p: Page, label: string): Promise<void> {
  const ok = await p.js<boolean>(`(() => {
    const b = [...document.querySelectorAll('button.activity-btn')].find((e) => (e.getAttribute('aria-label') || '').startsWith(${JSON.stringify(label)}))
    if (b) b.click()
    return !!b
  })()`)
  if (!ok) throw new Error(`no activity-bar section "${label}"`)
  await p.sleep(900)
}

/**
 * Click the thing that reads `text`. Controls win over prose: "Read containers"
 * is both a button and a bold phrase in the help text beside it, and the help
 * text is the later, deeper match.
 */
async function tap(p: Page, text: string, scope = 'body', startsWith = false): Promise<void> {
  const ok = await p.js<boolean>(`(() => {
    const t = ${JSON.stringify(text)}
    const hit = (e) => { const s = (e.textContent || '').trim(); return ${startsWith} ? s.startsWith(t) : s === t }
    const all = [...document.querySelector(${JSON.stringify(scope)}).querySelectorAll('*')]
      .filter((e) => e.getBoundingClientRect().width > 0 && hit(e))
    const ctl = 'button, a, [role="tab"], [role="treeitem"], [role="option"], li, [tabindex]'
    const el = all.filter((e) => e.closest(ctl)).pop() || all.pop()
    if (el) (el.closest(ctl) || el).click()
    return !!el
  })()`)
  if (!ok) throw new Error(`nothing on screen reads "${text}"`)
  await p.sleep(700)
}

/** Choose an option in the first <select> that has it. */
async function pick(p: Page, option: string): Promise<void> {
  const ok = await p.js<boolean>(`(() => {
    for (const sel of document.querySelectorAll('select')) {
      const o = [...sel.options].find((x) => x.textContent.trim() === ${JSON.stringify(option)})
      if (!o) continue
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      set.call(sel, o.value)
      sel.dispatchEvent(new Event('input', { bubbles: true }))
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }
    return false
  })()`)
  if (!ok) throw new Error(`no select offers "${option}"`)
  await p.sleep(500)
}

/** Type into whatever has focus, a line at a time, pressing Enter after each. */
async function typeLines(p: Page, lines: string[]): Promise<void> {
  for (const line of lines) {
    await p.text(line)
    await p.key('Return')
    await p.sleep(600)
  }
}

export const SHOTS: Shot[] = [
  {
    name: 'fleet',
    async run(p) {
      await section(p, 'Monitoring')
      // Long enough for every card's sparkline to fill with a real history.
      await p.sleep(45_000)
    }
  },
  {
    name: 'posture',
    async run(p) {
      await section(p, 'Monitoring')
      await tap(p, 'Security posture')
      await tap(p, 'Check now')
      await p.sleep(8_000)
    }
  },
  {
    name: 'terminal',
    async run(p) {
      await section(p, 'Connections')
      await tap(p, 'api-01', '.sidebar')
      await p.sleep(2_500)
      await p.js(`document.querySelector('.xterm-helper-textarea')?.focus()`)
      await typeLines(p, ['uptime', 'docker ps', 'systemctl status nginx --no-pager'])
    }
  },
  {
    name: 'files',
    async run(p) {
      await tap(p, 'Files')
      await p.sleep(2_000)
    }
  },
  {
    name: 'database',
    async run(p) {
      await section(p, 'Databases')
      await tap(p, 'orders (primary)', '.sidebar')
      await p.sleep(2_000)
      await tap(p, 'orders')
      await p.sleep(1_000)
      await tap(p, 'Run', 'body', true)
      await p.sleep(2_000)
    }
  },
  {
    name: 'docker',
    async run(p) {
      await section(p, 'Docker')
      await pick(p, 'api-01')
      await tap(p, 'Read containers')
      await p.sleep(3_000)
    }
  },
  {
    name: 'kubernetes',
    async run(p) {
      await section(p, 'Kubernetes')
      await pick(p, 'k8s-control')
      await tap(p, 'Read cluster')
      await p.sleep(4_000)
    }
  },
  {
    name: 'http',
    async run(p) {
      await section(p, 'HTTP Client')
      // The URL bar is a code editor, not an <input>: focus it, then type.
      await tap(p, 'Paste a URL or a curl command')
      await p.text('https://api.example.com/v1/health')
      await tap(p, 'Send')
      await p.sleep(2_000)
    }
  },
  {
    name: 'vault',
    async run(p) {
      await section(p, 'Vault')
      await tap(p, 'Grafana')
      await p.sleep(1_500)
    }
  },
  {
    name: 'workspaces',
    async run(p) {
      await p.click('.ws-trigger')
      await tap(p, 'Manage workspaces')
      await p.sleep(1_000)
    }
  },
  {
    name: 'access',
    async run(p) {
      await p.key('Escape')
      await section(p, 'AI & MCP')
      await tap(p, 'Access Groups')
      await tap(p, 'Contractors')
      await p.sleep(800)
      // The per-capability grid is a collapsed section under the cards: open
      // it and bring it to the top of the frame.
      await p.js(`(() => {
        const d = [...document.querySelectorAll('details')].find((e) =>
          (e.querySelector('summary')?.textContent || '').trim().startsWith('Capabilities'))
        if (!d) return
        d.open = true
        d.scrollIntoView({ block: 'start' })
      })()`)
      await p.sleep(800)
    }
  },
  {
    name: 'audit',
    async run(p) {
      await tap(p, 'Audit Log')
      await p.sleep(2_000)
    }
  },
  {
    name: 'approval',
    async run(p) {
      raiseDemoApproval()
      await p.sleep(3_000)
    }
  }
]
