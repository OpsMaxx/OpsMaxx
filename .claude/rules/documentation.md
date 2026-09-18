# Documentation rules

DocGov governs documentation in this repository. Mode: `open-source`. Layout: `full`.

These rules apply to every agent and every human. They exist because a repository
with many authors — most of them now agents — degrades its documentation faster
than any review process can repair it.

## Before creating any documentation

1. **Check whether it already exists.** `docgov find "<topic>"` returns results in
   authority order. If an authoritative document already covers the topic, update
   that document. Do not create a second one.
2. **Find out what you are writing.** `docgov whatis --path <intended-file>` names
   the document class, its canonical location, its required sections and its limits.
3. **Create it through DocGov.** `docgov create <type> "<name>" [--domain <d>]` puts
   it in the right place, applies the template, and wires it into the graph. A
   document not in the graph is invisible to impact analysis, which means nobody
   will be told when it goes stale.

Never invent a new top-level Markdown file. Never invent a new documentation
directory. The taxonomy has 59 document classes; run `docgov types` before
concluding that yours is not one of them.

## Before editing code in a governed area

Run `docgov brief <domain>` and read it. It is the minimum authoritative context
for that area: the constitution, the canonical specification, the rules in
force, the relevant ADRs and the machine contracts — and nothing else.

If a rule blocks what you were about to do, the rule wins. Changing it
means changing its source document in the same change, with a reason.

## Authority

Authority is ordered and it is not negotiable:

```
constitution  >  canonical  >  requirements / decision  >  machine contract
              >  implementation  >  generated  >  audience  >  historical
```

A lower-authority document may not contradict a higher one. If you find a
contradiction, do not fix it by editing the lower document into agreement — work
out which one is actually right, fix that one, and record the decision.

Machine contracts (OpenAPI, JSON Schema, protobuf, GraphQL, migrations) are
authoritative over any prose that describes them. Reference them; do not restate
their contents.

## Writing

- Apply the template for the class. Required sections are a deterministic gate, not
  a style preference — a TRD with no failure analysis is not a TRD.
- Respect the audience. A README answers "what is this and how do I start" in under
  300 lines and links everything deeper. An architecture document does not explain
  how to install anything.
- Keep one document to one concept. If a document holds several independently
  addressable concepts, it should be a directory with an index.
- Never edit a generated document. Change its source and regenerate.
- Never edit the archive. It is a historical record.
- No TBD, TODO or FIXME in a document another agent will read as fact. Either state
  what is true, or say explicitly that it is unknown and who owns finding out.

## After changing anything material

1. `docgov affected` — which documents this change affects, and which of them are
   required rather than optional.
2. Update the required ones in the same change. "I will document it later" is how
   drift starts.
3. `docgov check` — deterministic violations. Blocking checks in this mode:
   `generated-edit, duplicate-id, invalid-yaml, broken-link, visibility-path`.
4. If a check is genuinely wrong for your case, `docgov ignore <ID> --reason "..."`.
   A suppression needs a reason, stays visible in every report, and can expire. What
   it never does is disappear.

## What DocGov will not do for you

It will not decide whether two documents contradict each other, whether a document
should be split, or whether prose is clear. Those are judgement calls: they are
reported for review, never enforced automatically. Everything DocGov blocks is
something software can decide without guessing.
