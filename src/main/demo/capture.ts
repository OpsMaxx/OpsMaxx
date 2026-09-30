import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Walk the screens and save the site's screenshots, then quit.
 *
 * Driven from the outside, the way a person would drive it: DOM clicks and
 * typing through executeJavaScript, and Electron's own capturePage for the
 * pixels -- no automation dependency, and nothing in the renderer knows a
 * capture is happening.
 *
 * Every shot is cropped to the site's 99:50 frame and written at 1800x909 (the
 * site's tour frame is `aspect-[99/50]`; anything else gets cropped by
 * object-cover). A step that fails names itself and the run carries on, so one
 * moved button costs one screenshot rather than the lot.
 */

export interface Page {
  /** Run JS in the renderer and return its result. */
  js<T = unknown>(code: string): Promise<T>
  click(selector: string): Promise<void>
  clickText(text: string, within?: string): Promise<void>
  type(selector: string, text: string): Promise<void>
  /** Type into whatever has focus. */
  text(text: string): Promise<void>
  key(keyCode: string, modifiers?: ('meta' | 'control' | 'shift')[]): Promise<void>
  waitFor(selector: string, timeoutMs?: number): Promise<void>
  sleep(ms: number): Promise<void>
}

export interface Shot {
  name: string
  /** Get the screen into the state to be photographed. */
  run(p: Page): Promise<void>
  /** What to crop to. Defaults to the main content area. */
  crop?: string
  /** Frame this element instead: itself plus a margin, widened to 99:50 around
   *  its centre. For a dialog, which is lost at site width in a whole window. */
  focus?: string
}

const OUT_W = 1800
const OUT_H = Math.round((OUT_W * 50) / 99)

function page(win: BrowserWindow): Page {
  const wc = win.webContents
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const js = <T>(code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
  const p: Page = {
    js,
    sleep,
    async waitFor(selector, timeoutMs = 10_000) {
      const until = Date.now() + timeoutMs
      while (Date.now() < until) {
        if (await js<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`)) return
        await sleep(150)
      }
      throw new Error(`timed out waiting for ${selector}`)
    },
    async click(selector) {
      await p.waitFor(selector)
      await js(`document.querySelector(${JSON.stringify(selector)}).click()`)
      await sleep(400)
    },
    async clickText(text, within = 'button, [role="tab"], a, [role="menuitem"], .seg-btn') {
      const ok = await js<boolean>(`(() => {
        const t = ${JSON.stringify(text)}
        const el = [...document.querySelectorAll(${JSON.stringify(within)})]
          .find((e) => e.textContent.trim() === t || e.getAttribute('aria-label') === t || e.getAttribute('title') === t)
        if (el) el.click()
        return !!el
      })()`)
      if (!ok) throw new Error(`no element with text "${text}"`)
      await sleep(400)
    },
    async type(selector, text) {
      await p.click(selector)
      for (const ch of text) wc.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(200)
    },
    async text(text) {
      for (const ch of text) {
        wc.sendInputEvent({ type: 'char', keyCode: ch })
        await sleep(25)
      }
    },
    async key(keyCode, modifiers = []) {
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
      await sleep(300)
    }
  }
  return p
}

async function capture(win: BrowserWindow, crop: string, file: string, focus?: string): Promise<void> {
  const rect = await win.webContents.executeJavaScript(
    focus
      ? `(() => {
          const r = document.querySelector(${JSON.stringify(focus)})?.getBoundingClientRect()
          if (!r) return null
          const W = innerWidth, H = innerHeight, pad = 48
          let w = r.width + pad * 2, h = r.height + pad * 2
          if (w / h < 99 / 50) w = (h * 99) / 50
          else h = (w * 50) / 99
          w = Math.min(w, W); h = Math.min(h, H)
          const x = Math.min(Math.max(0, r.x + r.width / 2 - w / 2), W - w)
          const y = Math.min(Math.max(0, r.y + r.height / 2 - h / 2), H - h)
          return { x, y, width: w, height: h }
        })()`
      : `(() => { const r = document.querySelector(${JSON.stringify(crop)})?.getBoundingClientRect()
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null })()`,
    true
  )
  if (!rect) throw new Error(`nothing to crop to: ${crop}`)
  // The rect is in CSS pixels; capturePage wants window pixels. They differ by
  // the page zoom, which the demo sets so the whole app fits the frame.
  const z = win.webContents.getZoomFactor()
  for (const k of ['x', 'y', 'width', 'height'] as const) rect[k] *= z
  // Largest 99:50 box inside the element, anchored top-left, where the
  // content that matters starts.
  let w = Math.floor(rect.width)
  let h = Math.floor((w * 50) / 99)
  if (h > rect.height) {
    h = Math.floor(rect.height)
    w = Math.floor((h * 99) / 50)
  }
  const img = await win.webContents.capturePage({ x: Math.round(rect.x), y: Math.round(rect.y), width: w, height: h })
  writeFileSync(file, img.resize({ width: OUT_W, height: OUT_H, quality: 'best' }).toPNG())
}

export async function runCapture(outdir: string, shots: Shot[], defaultCrop: string): Promise<void> {
  mkdirSync(outdir, { recursive: true })
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) throw new Error('no window to capture')
  const p = page(win)
  const failed: string[] = []
  for (const shot of shots) {
    try {
      await shot.run(p)
      await p.sleep(1200)
      await capture(win, shot.crop ?? defaultCrop, join(outdir, `${shot.name}.png`), shot.focus)
      console.warn(`[demo] captured ${shot.name}`)
    } catch (err) {
      failed.push(shot.name)
      console.warn(`[demo] ${shot.name} failed: ${(err as Error).message}`)
      try {
        const img = await win.webContents.capturePage()
        writeFileSync(join(outdir, `_failed-${shot.name}.png`), img.toPNG())
      } catch {
        /* the failure is already reported */
      }
    }
  }
  console.warn(`[demo] ${shots.length - failed.length}/${shots.length} captured to ${outdir}${failed.length ? `; failed: ${failed.join(', ')}` : ''}`)
  app.quit()
}
