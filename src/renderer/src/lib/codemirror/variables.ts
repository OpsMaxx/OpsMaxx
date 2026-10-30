import { StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  hoverTooltip,
  keymap,
  showTooltip,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate
} from '@codemirror/view'
import type { VariableScope, VariableScopeChain } from '../../../../shared/apiVariables'
import { parseVaultReference } from '../../../../shared/apiSecrets'
import { useVault } from '../../store/vault'
import type { MessageKey } from '../../../../shared/i18n'
import { t } from '../i18n'

/** `{{name}}`, with optional inner spaces. The name is group 1. */
export const VARIABLE_TOKEN = /\{\{\s*([^{}\s]+)\s*\}\}/g

export interface VariableHit {
  scope: VariableScope
  /** The layer's display name: the environment or collection name, or "Globals". */
  layer: string
  value: string
  /** Broader layers that also define it and lose. */
  overridden: VariableScope[]
}

/** The narrowest enabled definition of `name`, or null. */
export function lookupVariable(chain: VariableScopeChain, name: string): VariableHit | null {
  let hit: VariableHit | null = null
  const shadowed: VariableScope[] = []
  for (const layer of chain.layers) {
    const v = layer.variables.find((x) => x.enabled && x.key === name)
    if (!v) continue
    if (hit) shadowed.push(hit.scope)
    hit = { scope: layer.scope, layer: layer.name, value: v.value, overridden: [] }
  }
  return hit && { ...hit, overridden: shadowed }
}

/** The `{{name}}` token around `pos`, if any. */
export function variableAt(text: string, pos: number): { name: string; from: number; to: number } | null {
  for (const m of text.matchAll(VARIABLE_TOKEN)) {
    const from = m.index ?? 0
    const to = from + m[0].length
    if (pos >= from && pos <= to) return { name: m[1], from, to }
  }
  return null
}

const marks = {
  unresolved: Decoration.mark({ class: 'hc-var hc-var--unresolved' }),
  global: Decoration.mark({ class: 'hc-var hc-var--global' }),
  collection: Decoration.mark({ class: 'hc-var hc-var--collection' }),
  environment: Decoration.mark({ class: 'hc-var hc-var--environment' })
}

/**
 * `{{var}}` decorations: coloured by the scope that resolves them, and
 * underlined when nothing does. Colour is never the only signal: an
 * unresolved token is also underlined (hc-var--unresolved in nav.css).
 */
export function variableDecorations(chain: VariableScopeChain): Extension {
  const matcher = new MatchDecorator({
    regexp: VARIABLE_TOKEN,
    decoration: (m) => marks[lookupVariable(chain, m[1])?.scope ?? 'unresolved']
  })
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view)
      }
      update(u: ViewUpdate): void {
        this.decorations = matcher.updateDeco(u, this.decorations)
      }
    },
    { decorations: (v) => v.decorations }
  )
}

const FROM_TEXT: Record<VariableScope, MessageKey> = {
  global: 'lib.variables.from.global',
  collection: 'lib.variables.from.collection',
  environment: 'lib.variables.from.environment'
}

const SCOPE_TEXT: Record<VariableScope, MessageKey> = {
  global: 'lib.variables.scope.global',
  collection: 'lib.variables.scope.collection',
  environment: 'lib.variables.scope.environment'
}

/**
 * The card's content, as text nodes only. A vault-backed value shows the
 * entry's name and a lock, never the value.
 */
export function variableCardDom(chain: VariableScopeChain, name: string): HTMLElement {
  const el = (tag: string, cls: string, text: string): HTMLElement => {
    const n = document.createElement(tag)
    n.className = cls
    n.textContent = text
    return n
  }
  const card = document.createElement('div')
  card.className = 'hc-var-card'
  card.append(el('div', 'hc-var-card-name', `{{${name}}}`))
  const hit = lookupVariable(chain, name)
  if (!hit) {
    const env = chain.layers.find((l) => l.scope === 'environment')
    card.append(
      el(
        'div',
        'hc-var-card-missing',
        env
          ? t('lib.variables.notDefinedIn', { env: env.name })
          : t('lib.variables.notDefinedNoEnv')
      )
    )
    return card
  }
  const ref = parseVaultReference(hit.value)
  if (ref) {
    const entry = useVault.getState().entries.find((e) => e.id === ref.entryId)
    const label = entry
      ? entry.name
      : useVault.getState().unlocked
        ? t('lib.variables.vaultEntryGone')
        : t('lib.variables.vaultEntryLocked')
    const shown = ref.field === 'username' ? t('lib.variables.vaultUsername', { label }) : label
    card.append(el('div', 'hc-var-card-value', `🔒 ${shown}`))
  } else {
    card.append(el('div', 'hc-var-card-value', hit.value === '' ? t('lib.variables.empty') : hit.value))
  }
  const from = t(FROM_TEXT[hit.scope], { layer: hit.layer })
  card.append(
    el(
      'div',
      'hc-var-card-scope',
      hit.overridden.length
        ? t('lib.variables.overrides', { from, scopes: hit.overridden.map((s) => t(SCOPE_TEXT[s])).join(', ') })
        : from
    )
  )
  return card
}

const openCard = StateEffect.define<number | null>()

/**
 * The variable card: on hover over a `{{token}}`, on Mod-i with the caret in
 * one, or after the caret rests 500 ms inside one. Escape closes it.
 */
export function variableCard(chain: VariableScopeChain): Extension {
  const tooltipAt = (text: string, pos: number): Tooltip | null => {
    const hit = variableAt(text, pos)
    return hit && { pos: hit.from, end: hit.to, above: false, create: () => ({ dom: variableCardDom(chain, hit.name) }) }
  }
  const field = StateField.define<Tooltip | null>({
    create: () => null,
    update(value, tr) {
      for (const e of tr.effects) if (e.is(openCard)) return e.value === null ? null : tooltipAt(tr.state.doc.toString(), e.value)
      return tr.docChanged || tr.selection ? null : value
    },
    provide: (f) => showTooltip.from(f)
  })
  const rest = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | undefined
      constructor(readonly view: EditorView) {}
      update(u: ViewUpdate): void {
        if (!u.selectionSet && !u.docChanged) return
        clearTimeout(this.timer)
        const pos = u.state.selection.main.head
        if (!u.state.selection.main.empty || !variableAt(u.state.doc.toString(), pos)) return
        this.timer = setTimeout(() => this.view.dispatch({ effects: openCard.of(pos) }), 500)
      }
      destroy(): void {
        clearTimeout(this.timer)
      }
    }
  )
  return [
    field,
    rest,
    keymap.of([
      {
        key: 'Mod-i',
        run: (view) => {
          const pos = view.state.selection.main.head
          if (!variableAt(view.state.doc.toString(), pos)) return false
          view.dispatch({ effects: openCard.of(pos) })
          return true
        }
      },
      {
        key: 'Escape',
        run: (view) => {
          if (!view.state.field(field)) return false
          view.dispatch({ effects: openCard.of(null) })
          return true
        }
      }
    ]),
    hoverTooltip((view, pos) => tooltipAt(view.state.doc.toString(), pos))
  ]
}
