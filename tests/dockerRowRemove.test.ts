import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DOCKER_MARKERS,
  buildDockerReclaimPreview,
  parseDockerDiskDetailOutput,
  reclaimItemForContainer
} from '../src/shared/docker'

// Remove on a container's own row. It goes through the reclaim offer set, so
// it can offer exactly what Disk usage would and refuse exactly what it would.
// Fixture recorded from Docker 29.5.3; see tests/fixtures/docker/README.md.

const REAL_DFV = readFileSync(join(__dirname, 'fixtures/docker/system-df-v-docker-29.txt'), 'utf8')

function preview(): ReturnType<typeof buildDockerReclaimPreview> {
  const r = parseDockerDiskDetailOutput(`${DOCKER_MARKERS.dfDetail}\n${REAL_DFV}\n${DOCKER_MARKERS.end}\n`, 0)
  if (!r.ok) throw new Error(`the recorded df -v no longer parses: ${r.detail}`)
  return buildDockerReclaimPreview(r.disk)
}

describe('the Remove button on a container row', () => {
  it('offers an exited container as the same reclaim item Disk usage would', () => {
    const found = reclaimItemForContainer(preview(), '9b2c7e4d1a08')
    expect(found).not.toBeNull()
    expect(found && 'item' in found && found.item).toMatchObject({ kind: 'container', id: '9b2c7e4d1a08' })
  })

  it('matches a full id against the short one docker df prints', () => {
    const found = reclaimItemForContainer(preview(), '9b2c7e4d1a08' + 'f'.repeat(52))
    expect(found && 'item' in found).toBe(true)
  })

  it('refuses a running container with the reclaim path’s own reason', () => {
    expect(reclaimItemForContainer(preview(), '15a40f70ae59')).toEqual({ withheld: 'it is running' })
  })

  it('never matches on a short or empty id', () => {
    expect(reclaimItemForContainer(preview(), '9b2c')).toBeNull()
    expect(reclaimItemForContainer(preview(), '')).toBeNull()
  })
})
