import { Fragment, cloneElement, type ReactElement, type ReactNode } from 'react'
import { useT } from './i18n'
import type { MessageKey, Vars } from '../../../shared/i18n'

// A translated sentence with markup inside it, in react-i18next's shape, so a
// later move to that library leaves every call site alone:
//
//   "settings.fontSize.desc": "Also <b>Ctrl +</b> and <b>Ctrl -</b>."
//   <Trans i18nKey="settings.fontSize.desc" components={{ b: <b /> }} />
//
// The translator moves the tags with the words; the element each tag becomes
// is supplied here, so a pack can only use tags the call site names, and their
// text is rendered as text. A tag the call site did not name renders as its
// plain text. Tags do not nest, and `<br/>` is the one self-closing tag.

const TAG = /<(\w+)>(.*?)<\/\1>|<(\w+)\s*\/>/gs

export function Trans({
  i18nKey,
  values,
  components = {}
}: {
  i18nKey: MessageKey
  values?: Vars
  components?: Record<string, ReactElement>
}): ReactNode {
  const msg = useT()(i18nKey, values)
  const out: ReactNode[] = []
  let last = 0
  for (const m of msg.matchAll(TAG)) {
    if (m.index > last) out.push(msg.slice(last, m.index))
    const [whole, name, inner, selfClosing] = m
    const el = components[name ?? selfClosing]
    out.push(
      el ? (
        <Fragment key={m.index}>{selfClosing ? el : cloneElement(el, {}, inner)}</Fragment>
      ) : (
        (inner ?? whole)
      )
    )
    last = m.index + whole.length
  }
  if (last < msg.length) out.push(msg.slice(last))
  return <>{out}</>
}
