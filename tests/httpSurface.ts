import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// The files the HTTP redesign adds, for the two tests that fence them in
// (httpNoRendererNetwork, httpIsolation). Listed by directory and by name so a
// file added next week under components/http is covered without anyone
// remembering to come back here.

export const SRC = fileURLToPath(new URL('../src', import.meta.url))
export const RENDERER = join(SRC, 'renderer/src')

/** The pre-redesign client, deleted by the cutover commit. */
export const OLD_HTTP = ['ScalarClient', 'AddApiModal', 'EnvironmentBar', 'ApiSidebar', 'WsConsole', 'GraphQlConsole', 'HttpView']

export function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const isOld = (p: string): boolean =>
  relative(join(RENDERER, 'components/http'), p).split('/').length === 1 &&
  OLD_HTTP.some((name) => p.endsWith(`/${name}.tsx`))

const named = (dir: string, names: string[]): string[] => names.map((n) => join(dir, n)).filter(existsSync)

/** Every new source file of the redesign: components, stores, glue and shared modules. */
export function newHttpFiles(): string[] {
  return [
    ...walk(join(RENDERER, 'components/http')).filter((p) => !isOld(p)),
    ...named(join(RENDERER, 'components/common'), [
      'SplitPane.tsx',
      'KeyValueTable.tsx',
      'CodeEditor.tsx',
      'Tabs.tsx',
      'SplitButton.tsx',
      'Popover.tsx',
      'primitives.css'
    ]),
    ...walk(join(RENDERER, 'lib/codemirror')),
    ...named(join(RENDERER, 'lib'), ['httpSend.ts']),
    ...named(join(RENDERER, 'store'), [
      'api.ts',
      'http.ts',
      'httpCookies.ts',
      'wsSessions.ts',
      'gqlSchemas.ts',
      'persistHttp.ts'
    ]),
    ...named(join(SRC, 'shared'), [
      'apiModel.ts',
      'apiVariables.ts',
      'apiUrl.ts',
      'apiRequestBuild.ts',
      'apiMigration.ts',
      'httpErrors.ts',
      'autoHeaders.ts',
      'curl.ts',
      'apiOpenApi.ts',
      'openapiImport.ts',
      'httpHistory.ts'
    ])
  ]
}

export const read = (p: string): string => readFileSync(p, 'utf8')
export const rel = (p: string): string => relative(SRC, p)

/** Source with comments removed, so prose about `fetch()` is not a finding. */
export function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}
