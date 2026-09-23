import type { Extension } from '@codemirror/state'
import { json } from '@codemirror/lang-json'
import { xml } from '@codemirror/lang-xml'
import { html } from '@codemirror/lang-html'
import { yaml } from '@codemirror/lang-yaml'

export type EditorLanguage = 'json' | 'xml' | 'html' | 'yaml' | 'text'

export function languageFor(language: EditorLanguage): Extension {
  switch (language) {
    case 'json':
      return json()
    case 'xml':
      return xml()
    case 'html':
      return html()
    case 'yaml':
      return yaml()
    case 'text':
      return []
  }
}
