# `x-*` keys in the v1 fixtures

Every `x-scalar-*` (and other `x-`) key path seen across the fixtures in this
directory. `<slug>` is the collection id (documents are keyed by it), `<path>` an
OpenAPI path, `<method>` a lowercase HTTP method, `<name>` an example name
(`default` in every capture), `<env>` an environment name.

## Where each piece of user state lives

| State | Path | Value |
|---|---|---|
| Selected server | `apiWorkspace.documents.<slug>.x-scalar-selected-server` | the server's URL string; absent until one is picked (first server implied) |
| Operation order | `apiWorkspace.documents.<slug>.x-scalar-order` (top level: intro + tags, or intro + operations when untagged) and `apiWorkspace.documents.<slug>.tags[].x-scalar-order` (operations within a tag) | arrays of navigation ids, `<slug>/tag/<tag>/<METHOD>/<path>` |
| Selected content type | `apiWorkspace.documents.<slug>.paths.<path>.<method>.requestBody.x-scalar-selected-content-type` | `{ <exampleName>: <mediaType> }`, keyed per example |
| Disabled param | `apiWorkspace.documents.<slug>.paths.<path>.<method>.parameters[].examples.<name>.x-disabled` | `true` / `false`; **absent** means the default (optional params show unticked) |
| Edited example | `apiWorkspace.documents.<slug>.paths.<path>.<method>.parameters[].examples.<name>.value` and `…requestBody.content.<mediaType>.examples.<name>.value` | plain OpenAPI, no `x-` marker; an imported `example:` is rewritten into `examples.default` |
| Environments | `apiWorkspace.meta.x-scalar-environments.<env>` | `{ color, variables: [{ name, value }] }`; a secret value is `vault:<entryId>#password` |
| Active environment | `apiWorkspace.meta.x-scalar-active-environment` | environment name; absent until one is set |

## Inventory

| Key path | Fixtures | Meaning |
|---|---|---|
| `apiWorkspace.meta.x-scalar-active-document` | all with a snapshot | slug the client is writing into (set on every collection switch) |
| `apiWorkspace.meta.x-scalar-active-proxy` | all with a snapshot | always `null`: OpsMaxx disables Scalar's third-party proxy |
| `apiWorkspace.meta.x-scalar-environments` | environments | workspace-level environments and their variables |
| `apiWorkspace.meta.x-scalar-active-environment` | environments | which environment requests interpolate from |
| `apiWorkspace.documents.<slug>.x-original-oas-version` | all with a document | OpenAPI version before Scalar upgraded it (hand-built collections say `3.1.1`) |
| `apiWorkspace.documents.<slug>.x-scalar-original-document-hash` | all with a document | hash of the document as first loaded |
| `apiWorkspace.documents.<slug>.x-scalar-original-source-url` | openapi-* | spec URL the document was fetched from; absent for hand-built ones |
| `apiWorkspace.documents.<slug>.x-ext-urls` | all with a document | external `$ref` URL map, `{}` in every capture |
| `apiWorkspace.documents.<slug>.x-scalar-order` | all with a document | top-level sidebar order |
| `apiWorkspace.documents.<slug>.tags[].x-scalar-order` | openapi-* | operation order inside a tag |
| `apiWorkspace.documents.<slug>.x-scalar-navigation` | all with a document | the built sidebar tree (derived, rebuildable) |
| `apiWorkspace.documents.<slug>.x-scalar-navigation.children[].xKeys.x-scalar-order` | openapi-* | copy of the tag's `x-scalar-order` inside the tree |
| `apiWorkspace.documents.<slug>.x-scalar-selected-server` | openapi-switched-server | chosen server URL |
| `apiWorkspace.documents.<slug>.x-scalar-is-dirty` | every document edited in the client | `true` once edited; absent on an untouched document (environments) |
| `apiWorkspace.documents.<slug>.paths.<path>.<method>.parameters[].examples.<name>.x-disabled` | hand-written, openapi-edited, two-workspaces | whether the param row is unticked |
| `apiWorkspace.documents.<slug>.paths.<path>.<method>.requestBody.x-scalar-selected-content-type` | hand-written, openapi-content-type | body type chosen in the pane, per example |

Not `x-` keys, but part of the same contract: `apiWorkspace.version` (`1`),
`apiWorkspace.sourceKeys.<slug>` (JSON string of `{specUrl, specPath, baseUrl,
endpoints}`) and `apiWorkspace.shed` (slugs dropped for size).
