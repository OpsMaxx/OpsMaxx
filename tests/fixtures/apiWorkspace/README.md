# API client workspace fixtures (v1 snapshot)

What OpsMaxx **0.51.3** actually persisted for the HTTP client, for migration tests.
Every `v1-*` file in the table below was captured from the running app, not written by
hand. The hand-written edge cases are listed separately at the end.

## How they were captured

- Date: 2026-09-23. App: `package.json` version `0.51.3`, built with `npm run build`,
  launched with `npx electron . --user-data-dir=<fresh temp dir> --remote-debugging-port=…`
  (Electron 43.4.1, `@scalar/api-client` 3.18.0, `@scalar/workspace-store` 0.60.0).
  A fresh, isolated profile per case, except `v1-hand-written` (continues from
  `v1-start-empty`'s profile).
- Driven through the real UI over the Chrome DevTools Protocol: Add API, the Scalar
  request pane (clicks and typed input), the environment bar, the vault picker,
  Manage workspaces. No store or IPC call was used to create state.
- Dumped with `await window.opsmaxx.data.load()` in the renderer (the file on disk is
  encrypted), after waiting past both debounces (the client's 2 s snapshot debounce
  and the store's 400 ms save), and re-loaded to confirm it had settled. Each file is
  `{ apiCollections, apiWorkspace, workspaces: [{id, name}], activeWorkspaceId }`.
- OpenAPI cases import a small local spec served from `127.0.0.1:18081` (tags `pets`
  and `store`, `/pets/{petId}`, a JSON request-body example, one operation offering
  both `application/json` and `application/x-www-form-urlencoded`, query parameters,
  two servers). `v1-shed-spec` imports a generated 5.5 MiB spec from the same server.

## Anonymised

Nothing identifying was present to remove: every URL is `127.0.0.1` or
`api.example.test`, no user or host name appears, and the one token value is the
placeholder `dev-token-placeholder`. The prod token is a vault **reference**
(`vault:<entryId>#password`) to a throwaway entry in the throwaway profile; no vault
content is in any file. Ids (`api-…`, `ws-…`, `v-…`) are the app's own generated ids,
left as captured so every cross-reference (collection id = document slug = sourceKeys
key = navigation id prefix) still matches.

## Files

| File | What it is |
|---|---|
| `v1-start-empty.json` | One "Start empty" collection, untouched. `apiWorkspace` is **null**: nothing is snapshotted until something inside the client changes. |
| `v1-hand-written.json` | Start-empty collection edited in Scalar: header `X-Trace: abc`, query `debug=1` unticked, method switched GET→POST, JSON body `{"a":1}`. |
| `v1-openapi-edited.json` | Imported spec; `limit` example edited 10→25 and enabled, `status` ticked then unticked. |
| `v1-openapi-switched-server.json` | Imported spec; second server selected. |
| `v1-openapi-content-type.json` | Imported spec; `POST /store/order` body switched to Form URL Encoded. |
| `v1-environments.json` | Environments `dev` and `prod` (each `baseUrl` + `token`), prod token a vault reference, `prod` active. |
| `v1-two-workspaces.json` | Workspaces Personal and Work, one edited collection each, captured with Work active. |
| `v1-shed-spec.json` | A 5.5 MiB spec-URL collection, edited; the snapshot shed it (`shed: [slug]`, no document, no sourceKey). |

No `v1-openapi-reordered.json`: 0.51.3 passes `isDroppable: () => false` to Scalar's
sidebar, so a drag is refused and operation order cannot be changed in that version.
The order that does get stored (the default) is in every OpenAPI fixture.

Key paths: see [x-scalar-keys.md](x-scalar-keys.md).

## Hand-written edge cases

These describe inputs the UI cannot produce. They are for the migration's hostile-input
and edge-case tests, and they are not captures.

| File | What it is |
|---|---|
| `v1-hostile-ids.json` | Collection, workspace and environment ids and names that reach a prototype (`__proto__`, `constructor`, `prototype`), a duplicate id, non-object records, `__proto__` path and parameter names. |
| `v1-cyclic-doc.json` | A path item, a parameter and a schema that each `$ref` themselves. |
| `v1-not-a-snapshot.json` | A `version: 1` workspace whose `documents` is not a map; URL, file and hand-written collections. |
| `v1-cookies-proxy.json` | `x-scalar-cookies` in meta and in a document, a non-null `x-scalar-active-proxy` and `x-scalar-tabs`: the keys the legacy scrub removes. No capture had cookies. |

The over-cap and reordered-operations cases are generated inside `tests/apiMigration.test.ts`.
A 4 MiB file is not worth committing, and 0.51.3 could not reorder operations.
