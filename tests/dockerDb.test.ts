import { describe, expect, it } from 'vitest'
import {
  buildDbContainerAddressCommand,
  dbKindForImage,
  parseDbContainerAddress,
  parseDbContainerList
} from '../src/shared/dockerDb'

// Databases in Docker containers that publish no port. The list fixture is
// real output from Docker 29.9.2: a Postgres on an `--internal` network and a
// Redis on the default bridge, neither with `-p`.

const S = '\u0001'
const LIST =
  `===OPSMAXX-DBC===\n` +
  `/omx-redis${S}redis:7-alpine${S}bridge=172.17.0.2;${S}6379/tcp=;\n` +
  `/omx-pg${S}postgres:16-alpine${S}omx-int=172.20.0.2;${S}5432/tcp=;\n`

describe('listing database containers', () => {
  it('finds both, unpublished, with their private addresses', () => {
    const r = parseDbContainerList(LIST, 0)
    expect(r).toEqual({
      ok: true,
      containers: [
        { name: 'omx-pg', image: 'postgres:16-alpine', kind: 'postgres', port: 5432, published: false, networks: [{ name: 'omx-int', ip: '172.20.0.2' }] },
        { name: 'omx-redis', image: 'redis:7-alpine', kind: 'redis', port: 6379, published: false, networks: [{ name: 'bridge', ip: '172.17.0.2' }] }
      ]
    })
  })

  it('leaves out containers that are not databases', () => {
    const r = parseDbContainerList(`===OPSMAXX-DBC===\n/web${S}nginx:1.27${S}bridge=172.17.0.3;${S}80/tcp=8080;\n`, 0)
    expect(r).toEqual({ ok: true, containers: [] })
  })

  it('says when the port is also published, and picks the engine port among several', () => {
    const r = parseDbContainerList(`===OPSMAXX-DBC===\n/db${S}mysql:8${S}app=10.0.0.4;${S}33060/tcp=;3306/tcp=13306;\n`, 0)
    expect(r.ok && r.containers[0]).toMatchObject({ kind: 'mysql', port: 3306, published: true })
  })

  it('reports a Docker this account may not use as that, not as an empty host', () => {
    const r = parseDbContainerList(
      'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n',
      1
    )
    expect(r).toMatchObject({ ok: false, reason: 'permission-denied' })
  })
})

describe('recognising an engine from its image', () => {
  it.each([
    ['postgres:16-alpine', 'postgres'],
    ['docker.io/library/postgres:16', 'postgres'],
    ['timescale/timescaledb-ha:pg16', 'postgres'],
    ['mariadb:11', 'mysql'],
    ['mcr.microsoft.com/mssql/server:2022-latest', 'mssql'],
    ['mongo@sha256:abc', 'mongodb'],
    ['valkey/valkey:8', 'redis'],
    ['registry.example.com:5000/team/redis:7', 'redis'],
    ['clickhouse/clickhouse-server:24.8', 'clickhouse'],
    ['bitnami/clickhouse:24', 'clickhouse'],
    ['clickhouse/clickhouse-keeper:24.8', null],
    ['nginx:1.27', null]
  ])('%s → %s', (image, kind) => {
    expect(dbKindForImage(image)).toBe(kind)
  })
})

describe('looking a container up by name', () => {
  it('returns its first network address', () => {
    expect(parseDbContainerAddress('===OPSMAXX-DBC===\nomx-int=172.20.0.2;\n', 0)).toEqual({
      ok: true,
      ip: '172.20.0.2',
      network: 'omx-int'
    })
  })

  it('tells a removed container from a stopped one', () => {
    expect(parseDbContainerAddress('error: no such object: omx-nope\n', 1)).toMatchObject({ reason: 'not-found' })
    expect(parseDbContainerAddress('===OPSMAXX-DBC===\n\n', 0)).toMatchObject({ reason: 'no-address' })
  })

  it('refuses a name that is not a container name, before it reaches a shell', () => {
    expect(() => buildDbContainerAddressCommand('db; rm -rf /')).toThrow()
    expect(() => buildDbContainerAddressCommand('$(id)')).toThrow()
    expect(buildDbContainerAddressCommand('postgres-main')).toContain(' postgres-main ')
  })
})
