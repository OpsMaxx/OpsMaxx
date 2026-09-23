import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// The response Preview's safety rests partly on this policy: a sandboxed
// srcdoc iframe inherits it, so `img-src` and `default-src` are what stop a
// previewed page loading anything remote. Any widening has to be a reviewed
// change to this string, not a drive-by edit (review SEC-L3).
const PROD =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' data: ws://127.0.0.1:*"

describe('the production CSP', () => {
  it('is exactly the reviewed policy', () => {
    const src = readFileSync('src/main/index.ts', 'utf8')
    const policies = [...src.matchAll(/: "(default-src 'self';[^"]*)"/g)].map((m) => m[1])
    expect(policies).toEqual([PROD])
  })
})
