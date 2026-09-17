# DocGov fix plan

Generated 2026-09-13 12:57:15 · layout `full` · mode `open-source`

**Nothing has changed yet.** This plan is a proposal. Edit it freely — delete any action you
disagree with — then run `docgov fix` to execute exactly what remains.

```
SAFE               38  frontmatter and new documents; nothing moves
HIGH CONFIDENCE     5  files move to their canonical place, links repaired
NEEDS REVIEW       24  DocGov was not sure; read these before running `fix`
```

The first two are mechanical and reversible: run them and move on. The third is the part
that is actually asking you something.

> ⚠ The working tree is dirty. Commit or stash before migrating.

## Current state

- 29 documents, 0 machine contracts
- 8 documents could not be classified, 8 classified with low confidence
- 0 broken internal links, 4 suspected duplicate pairs
- stack detected: ci, tests, auth, iac-secrets
- 1 authority scope: sidecar/netd
  Documents inside these stay inside them, and each has its own README.
- existing agent instructions: CLAUDE.md, .claude/rules

## Proposed state

```
./
  CLAUDE.md
  CODE_OF_CONDUCT.md
  CONTRIBUTING.md
  README.md
  SECURITY.md
  THIRD-PARTY-NOTICES.md
docs/
  ai-agents.md
  databases.md
  security.md
  tunnels.md
  vault.md
  VPN.md
  workspaces.md
docs/01-product/features/
  features.md   ← docs/features.md
docs/01-product/requirements/
  cicd-module.md   ← docs/plans/cicd-module.md
docs/01-product/roadmap/
  roadmap-execution.md   ← docs/plans/roadmap-execution.md
  ROADMAP.md   ← docs/ROADMAP.md
docs/03-architecture/components/
  local-terminal-plan.md   ← docs/plans/local-terminal-plan.md
docs/03-architecture/overview/
  (to create)   (new)
docs/04-security/architecture/
  (to create)   (new)
docs/04-security/authorization/
  (to create)   (new)
docs/04-security/data-classification/
  (to create)   (new)
docs/04-security/threat-models/
  (to create)   (new)
  AI-SECURITY.md   ← docs/AI-SECURITY.md
  vpn-tunnel-clients.md   ← docs/plans/vpn-tunnel-clients.md
docs/05-engineering/development/
  (to create)   (new)
docs/05-engineering/testing/
  (to create)   (new)
docs/06-operations/configuration/
  (to create)   (new)
docs/06-operations/deployment/
  (to create)   (new)
docs/06-operations/observability/
  monitoring.md   ← docs/monitoring.md
docs/06-operations/runbooks/
  AI-MCP.md   ← docs/AI-MCP.md
  terminal.md   ← docs/terminal.md
docs/08-user/faq/
  faq.md   ← docs/faq.md
docs/08-user/getting-started/
  install.md   ← docs/install.md
docs/design/
  panel-audit.md
docs/plans/
  cicd-phase-2.md
packaging/winget/
  README.md
sidecar/netd/
  README.md
```

# Safe (38)

Nothing moves. Frontmatter added, missing documents created. `docgov fix` does all of this, and undoing it means deleting what it wrote.

## Annotations (29)

Frontmatter added so the document becomes addressable by id.

- `CLAUDE.md` — no docgov frontmatter; add id, type, authority, visibility
- `CODE_OF_CONDUCT.md` — no docgov frontmatter; add id, type, authority, visibility
- `CONTRIBUTING.md` — no docgov frontmatter; add id, type, authority, visibility
- `README.md` — no docgov frontmatter; add id, type, authority, visibility
- `SECURITY.md` — no docgov frontmatter; add id, type, authority, visibility
- `THIRD-PARTY-NOTICES.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/AI-MCP.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/AI-SECURITY.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/ROADMAP.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/VPN.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/ai-agents.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/databases.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/design/panel-audit.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/faq.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/features.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/install.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/monitoring.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/plans/cicd-module.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/plans/cicd-phase-2.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/plans/local-terminal-plan.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/plans/roadmap-execution.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/plans/vpn-tunnel-clients.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/security.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/terminal.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/tunnels.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/vault.md` — no docgov frontmatter; add id, type, authority, visibility
- `docs/workspaces.md` — no docgov frontmatter; add id, type, authority, visibility
- `packaging/winget/README.md` — no docgov frontmatter; add id, type, authority, visibility
- `sidecar/netd/README.md` — no docgov frontmatter; add id, type, authority, visibility

## Missing documents (9)

The repository implies these should exist.

- `docs/06-operations/deployment/` (operations.deployment) — ci detected (.github/workflows/ci.yml) but no Deployment Guide exists
- `docs/05-engineering/testing/` (engineering.testing) — ci detected (.github/workflows/ci.yml) but no Testing Strategy exists
- `docs/04-security/architecture/` (security.architecture) — auth detected (tests/sessionElevation.test.ts) but no Security Architecture exists
- `docs/04-security/authorization/` (security.authorization) — auth detected (tests/sessionElevation.test.ts) but no Authorization Model exists
- `docs/04-security/threat-models/` (security.threat-model) — auth detected (tests/sessionElevation.test.ts) but no Threat Model exists
- `docs/04-security/data-classification/` (security.data-classification) — iac-secrets detected (src/renderer/src/components/vault/VaultSidebar.tsx) but no Data Classification exists
- `docs/06-operations/configuration/` (operations.configuration) — iac-secrets detected (src/renderer/src/components/vault/VaultSidebar.tsx) but no Configuration Reference exists
- `docs/03-architecture/overview/` (architecture.overview) — every repository should have this
- `docs/05-engineering/development/` (engineering.development) — every repository should have this

# High confidence (5)

Files move to the canonical position for their class, and every internal link that pointed at them is repaired in the same commit. `docgov fix` does these too. Nothing here is a guess — but a path is a thing other software remembers, so read the list.

## Moves (5)

Relocated to the canonical position for their class. Links are repaired automatically.

- `DG-44346` `docs/ROADMAP.md` → `docs/01-product/roadmap/ROADMAP.md`  
  a Roadmap belongs in docs/01-product/roadmap/
- `DG-49851` `docs/faq.md` → `docs/08-user/faq/faq.md`  
  a FAQ belongs in docs/08-user/faq/
- `DG-64363` `docs/features.md` → `docs/01-product/features/features.md`  
  a Feature Spec belongs in docs/01-product/features/
- `DG-53223` `docs/monitoring.md` → `docs/06-operations/observability/monitoring.md`  
  a Observability belongs in docs/06-operations/observability/
- `DG-22869` `docs/plans/roadmap-execution.md` → `docs/01-product/roadmap/roadmap-execution.md`  
  a Roadmap belongs in docs/01-product/roadmap/

# Needs review (24)

DocGov could not settle these on its own. Two different things live here, and they behave differently:

- **Moves and classifications** — `docgov fix` **will** carry these out. What is uncertain is not the operation but what the document *is*: no signal won clearly. Check them, or delete the ones you disagree with from this plan before running `fix`.
- **Splits, merges and extractions** — prose has to be rewritten, so `fix` never does them on its own. They need `--include split,merge,extract`, and even then one at a time.

## Moves (7)

The destination follows from a classification no signal won clearly. `fix` will still move these — the reason each was classified as it was is on every line.

- `DG-52155` `docs/AI-MCP.md` → `docs/06-operations/runbooks/AI-MCP.md`  
  a Runbook belongs in docs/06-operations/runbooks/
- `DG-77693` `docs/AI-SECURITY.md` → `docs/04-security/threat-models/AI-SECURITY.md`  
  a Threat Model belongs in docs/04-security/threat-models/
- `DG-64847` `docs/install.md` → `docs/08-user/getting-started/install.md`  
  a Getting Started belongs in docs/08-user/getting-started/
- `DG-14307` `docs/plans/cicd-module.md` → `docs/01-product/requirements/cicd-module.md`  
  a PRD belongs in docs/01-product/requirements/
- `DG-34589` `docs/plans/local-terminal-plan.md` → `docs/03-architecture/components/local-terminal-plan.md`  
  a TRD belongs in docs/03-architecture/components/
- `DG-15902` `docs/plans/vpn-tunnel-clients.md` → `docs/04-security/threat-models/vpn-tunnel-clients.md`  
  a Threat Model belongs in docs/04-security/threat-models/
- `DG-43117` `docs/terminal.md` → `docs/06-operations/runbooks/terminal.md`  
  a Runbook belongs in docs/06-operations/runbooks/

## Splits (8)

Each of these holds several independently addressable concepts. Needs your judgement.

- `THIRD-PARTY-NOTICES.md` — 528 lines across 3 independently addressable concepts
    - `THIRD-PARTY-NOTICES/bundled-binaries.md` ← "Bundled binaries" (124 lines)
    - `THIRD-PARTY-NOTICES/key-runtime-dependencies.md` ← "Key runtime dependencies" (71 lines)
    - `THIRD-PARTY-NOTICES/full-dependency-license-inventory-production-tre.md` ← "Full dependency license inventory (production tree)" (278 lines)
    - parent becomes an index that links the parts
- `docs/AI-MCP.md` — 550 lines across 3 independently addressable concepts
    - `docs/06-operations/runbooks/AI-MCP/the-mcp-server.md` ← "The MCP server" (160 lines)
    - `docs/06-operations/runbooks/AI-MCP/access-groups.md` ← "Access Groups" (73 lines)
    - `docs/06-operations/runbooks/AI-MCP/connecting-claude-desktop.md` ← "Connecting Claude Desktop" (61 lines)
    - parent becomes an index that links the parts
- `docs/ROADMAP.md` — 1969 lines across 6 independently addressable concepts
    - `docs/01-product/roadmap/ROADMAP/where-this-stands-as-of-0-16-x.md` ← "Where this stands, as of 0.16.x" (44 lines)
    - `docs/01-product/roadmap/ROADMAP/built-since-this-was-written.md` ← "Built since this was written" (82 lines)
    - `docs/01-product/roadmap/ROADMAP/the-gap-audit-5-sep-against-0-15-2.md` ← "The gap audit — 5 Sep, against 0.15.2" (1039 lines)
    - `docs/01-product/roadmap/ROADMAP/the-maintenance-tier-the-week-itself.md` ← "The maintenance tier — the week itself" (409 lines)
    - `docs/01-product/roadmap/ROADMAP/leverage-against-cost.md` ← "Leverage against cost" (205 lines)
    - `docs/01-product/roadmap/ROADMAP/the-plan-six-months-one-focused-person.md` ← "The plan — six months, one focused person" (71 lines)
    - parent becomes an index that links the parts
- `docs/plans/cicd-module.md` — 1451 lines across 12 independently addressable concepts
    - `docs/01-product/requirements/cicd-module/2-module-registration.md` ← "2. Module registration" (41 lines)
    - `docs/01-product/requirements/cicd-module/3-the-credential-problem-which-is-the-first-thin.md` ← "3. The credential problem, which is the first thing to solve" (55 lines)
    - `docs/01-product/requirements/cicd-module/4-authorization-approvals-audit.md` ← "4. Authorization, approvals, audit" (181 lines)
    - `docs/01-product/requirements/cicd-module/5-outbound-http.md` ← "5. Outbound HTTP" (184 lines)
    - `docs/01-product/requirements/cicd-module/6-provider-adapters.md` ← "6. Provider adapters" (208 lines)
    - `docs/01-product/requirements/cicd-module/7-polling.md` ← "7. Polling" (68 lines)
    - `docs/01-product/requirements/cicd-module/8-ux.md` ← "8. UX" (67 lines)
    - `docs/01-product/requirements/cicd-module/9-ai-agent-integration-mcp.md` ← "9. AI agent integration (MCP)" (256 lines)
    - `docs/01-product/requirements/cicd-module/10-files-to-touch.md` ← "10. Files to touch" (57 lines)
    - `docs/01-product/requirements/cicd-module/12-sequencing.md` ← "12. Sequencing" (43 lines)
    - `docs/01-product/requirements/cicd-module/13-open-questions.md` ← "13. Open questions" (62 lines)
    - `docs/01-product/requirements/cicd-module/14b-implementation-status.md` ← "14b. Implementation status" (92 lines)
    - parent becomes an index that links the parts
- `docs/plans/local-terminal-plan.md` — 2622 lines across 3 independently addressable concepts
    - `docs/03-architecture/components/local-terminal-plan/review-findings-read-before-starting.md` ← "⚠️ Review findings — read before starting" (303 lines)
    - `docs/03-architecture/components/local-terminal-plan/file-structure.md` ← "File structure" (42 lines)
    - `docs/03-architecture/components/local-terminal-plan/phase-plan.md` ← "Phase plan" (2137 lines)
    - parent becomes an index that links the parts
- `docs/plans/roadmap-execution.md` — 816 lines across 4 independently addressable concepts
    - `docs/01-product/roadmap/roadmap-execution/wave-1-the-cheap-wins-roadmap-19a-21.md` ← "Wave 1 — the cheap wins (roadmap 19a, 21)" (64 lines)
    - `docs/01-product/roadmap/roadmap-execution/wave-2-the-plumbing-roadmap-a-c-b.md` ← "Wave 2 — the plumbing (roadmap A, C, B)" (154 lines)
    - `docs/01-product/roadmap/roadmap-execution/wave-2-the-plumbing.md` ← "Wave 2 — the plumbing" (50 lines)
    - `docs/01-product/roadmap/roadmap-execution/item-29-a-renderer-that-can-be-tested.md` ← "Item 29 — a renderer that can be tested" (514 lines)
    - parent becomes an index that links the parts
- `docs/plans/vpn-tunnel-clients.md` — 1079 lines across 6 independently addressable concepts
    - `docs/04-security/threat-models/vpn-tunnel-clients/2-current-state-analysis.md` ← "2. Current-state analysis" (81 lines)
    - `docs/04-security/threat-models/vpn-tunnel-clients/3-engine-library-selection-matrix.md` ← "3. Engine / library selection matrix" (44 lines)
    - `docs/04-security/threat-models/vpn-tunnel-clients/5-architecture.md` ← "5. Architecture" (466 lines)
    - `docs/04-security/threat-models/vpn-tunnel-clients/6-per-protocol-integration-detail.md` ← "6. Per-protocol integration detail" (200 lines)
    - `docs/04-security/threat-models/vpn-tunnel-clients/8-edge-case-register.md` ← "8. Edge-case register" (83 lines)
    - `docs/04-security/threat-models/vpn-tunnel-clients/9-phased-implementation-plan.md` ← "9. Phased implementation plan" (46 lines)
    - parent becomes an index that links the parts
- `sidecar/netd/README.md` — 559 lines across 3 independently addressable concepts
    - `sidecar/netd/README/protocol.md` ← "Protocol" (190 lines)
    - `sidecar/netd/README/traffic-inspection-inspect.md` ← "Traffic inspection (`inspect.*`)" (57 lines)
    - `sidecar/netd/README/system-mode-privileged.md` ← "System mode (`--privileged`)" (133 lines)
    - parent becomes an index that links the parts

## Needs classification (9)

No signal matched. Tell DocGov what these are.

- `docs/VPN.md` — no classification signal matched
- `docs/ai-agents.md` — no classification signal matched
- `docs/databases.md` — no classification signal matched
- `docs/design/panel-audit.md` — no classification signal matched
- `docs/plans/cicd-phase-2.md` — no classification signal matched
- `docs/security.md` — `SECURITY.md` holds one document and is already claimed — left in place for you to decide
- `docs/tunnels.md` — no classification signal matched
- `docs/vault.md` — no classification signal matched
- `docs/workspaces.md` — no classification signal matched

## Suspected contradictions

Textual overlap narrows the candidates; only a reviewer can confirm a real contradiction.
Run `/docgov:inspect --contradictions` to have the architect agent adjudicate these pairs.

- `docs/AI-MCP.md` (historical) vs `docs/ai-agents.md` (historical) — 60% overlap. equal authority — a contradiction here has no tie-break
- `docs/AI-MCP.md` (historical) vs `docs/AI-SECURITY.md` (historical) — 58% overlap. equal authority — a contradiction here has no tie-break
- `docs/VPN.md` (historical) vs `docs/tunnels.md` (historical) — 58% overlap. equal authority — a contradiction here has no tie-break
- `docs/ROADMAP.md` (historical) vs `docs/plans/roadmap-execution.md` (historical) — 51% overlap. equal authority — a contradiction here has no tie-break

24 of 67 actions need a human or an agent to decide something.

## Execute

```bash
docgov fix --dry-run   # show every file operation, touch nothing
docgov fix             # on a new branch, mechanical actions only
docgov fix --include split,merge,extract   # also the judgement calls, one at a time
```

`migrate` runs MOVE, ANNOTATE and ARCHIVE automatically and repairs every internal link.
SPLIT, MERGE and EXTRACT are left to `/docgov:tag`, which uses an agent to rewrite prose.
