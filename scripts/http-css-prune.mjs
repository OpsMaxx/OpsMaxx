#!/usr/bin/env node
// Prunes the old HTTP client's rules from global.css, by selector (ARCH-B4).
//
// The old rules sat in two ranges, found here by their section comments rather
// than by line numbers, which drift. Inside them a selector is deleted only when
// one of its class tokens is written by no .ts/.tsx file under src/renderer, so
// shared vocabulary (.btn, .tree-*, .endpoints*) keeps every rule that still
// styles something. A rule goes when all of its selectors go; a comment goes
// with the rule it introduces; an @media block goes when it is left empty.
//
//   node scripts/http-css-prune.mjs          prints what it would delete and keep
//   node scripts/http-css-prune.mjs --write  rewrites global.css

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CSS = join(ROOT, 'src/renderer/src/styles/global.css')
// [a line inside the comment that opens the range, a line inside the comment
// that follows it]. A range whose opening comment is gone was pruned already.
const RANGES = [
  ['/* ============================= HTTP client', '/* ---- Remote desktop'],
  ['HTTP client: the three protocol panes.', '/* Cloud target picker'],
  // The hand-written endpoint editor and the old request pane, which sat
  // between the KPI tiles and the "Check now" progress rules.
  ['Hand-written endpoints', '"Check now", while it is running.']
]

function sources(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.tsx?$/.test(p)) out.push(readFileSync(p, 'utf8'))
  }
  return out
}
const code = sources(join(ROOT, 'src/renderer/src')).join('\n')
const used = new Map()
const isUsed = (token) => {
  if (!used.has(token)) {
    const escaped = token.replace(/[-]/g, '\\-')
    used.set(token, new RegExp(`(^|[^\\w-])${escaped}($|[^\\w-])`).test(code))
  }
  return used.get(token)
}

/** Top-level items of a CSS fragment: comments, rules and at-rule blocks, with the whitespace before each. */
function items(css) {
  const out = []
  let i = 0
  while (i < css.length) {
    const start = i
    while (i < css.length && /\s/.test(css[i])) i++
    if (i >= css.length) {
      out.push({ kind: 'space', text: css.slice(start) })
      break
    }
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i) + 2
      out.push({ kind: 'comment', text: css.slice(start, end) })
      i = end
      continue
    }
    const open = css.indexOf('{', i)
    let depth = 0
    let j = open
    for (; j < css.length; j++) {
      if (css.startsWith('/*', j)) j = css.indexOf('*/', j) + 1
      else if (css[j] === '{') depth++
      else if (css[j] === '}' && --depth === 0) break
    }
    const prelude = css.slice(i, open)
    out.push({ kind: prelude.trim().startsWith('@') ? 'at' : 'rule', lead: css.slice(start, i), prelude, body: css.slice(open, j + 1) })
    i = j + 1
  }
  return out
}

const report = { deleted: [], kept: [] }

/** Returns the fragment with dead selectors, rules and emptied blocks removed. */
function prune(css) {
  const list = items(css)
  let out = ''
  let pending = ''
  for (const item of list) {
    if (item.kind === 'space') {
      out += pending + item.text
      pending = ''
      continue
    }
    if (item.kind === 'comment') {
      pending += item.text
      continue
    }
    if (item.kind === 'at') {
      const inner = prune(item.body.slice(1, -1))
      if (inner.trim() === '') {
        pending = ''
        continue
      }
      out += pending + item.lead + item.prelude + '{' + inner + '}'
      pending = ''
      continue
    }
    const selectors = item.prelude.split(',').map((s) => s.trim()).filter(Boolean)
    const live = selectors.filter((sel) => {
      const tokens = [...sel.replace(/\[[^\]]*\]/g, '').matchAll(/\.(-?[a-zA-Z_][\w-]*)/g)].map((m) => m[1])
      const alive = tokens.every(isUsed)
      report[alive ? 'kept' : 'deleted'].push(sel)
      return alive
    })
    if (live.length === 0) {
      pending = ''
      continue
    }
    const prelude = live.length === selectors.length ? item.prelude : live.join(',\n') + ' '
    out += pending + item.lead + prelude + item.body
    pending = ''
  }
  return out + pending
}

let css = readFileSync(CSS, 'utf8')
for (const [startMark, endMark] of RANGES) {
  let a = css.indexOf(startMark)
  if (a === -1) {
    console.log(`already pruned: ${startMark}`)
    continue
  }
  a = css.lastIndexOf('/*', a)
  const end = css.indexOf(endMark, a)
  if (end === -1) throw new Error(`section end not found: ${endMark}`)
  const b = css.lastIndexOf('/*', end)
  const pruned = prune(css.slice(a, b)).replace(/\n{3,}/g, '\n\n')
  css = css.slice(0, a) + (pruned.trim() ? pruned.trim() + '\n\n' : '') + css.slice(b)
}

console.log(`deleted ${report.deleted.length} selectors:\n  ${report.deleted.join('\n  ')}`)
console.log(`kept ${report.kept.length} selectors:\n  ${report.kept.join('\n  ')}`)
if (process.argv.includes('--write')) writeFileSync(CSS, css)
