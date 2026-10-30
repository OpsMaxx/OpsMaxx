---
docgov:
  id: adr-0001-localization
  type: architecture.adr
  authority: decision
  audience:
    - engineering
    - architecture
  visibility: internal
  status: draft
  generation:
    mode: human-maintained
---
# Translate the UI with a small in-house translator that reads i18next-format packs

## Status

proposed

## Context

OpsMaxx is being localized into Simplified Chinese, French, Spanish and German, with English
as the source and default. Before this change there was no i18n at all: about 6,800
user-visible strings in the renderer and about 2,900 in main and shared code, all English
literals, with errors crossing IPC as finished English sentences.

Strings are needed in three places: the React renderer, the main process (the application
menu today, dialogs and notifications later), and Vitest, which runs main-process code with
no DOM. A git worktree of this repo has no `node_modules` of its own, so every added
dependency also has to be installed into the shared checkout.

## Decision

Use `src/shared/i18n.ts`, a dependency-free translator of about 100 lines, and store the
language packs in the file format i18next reads.

- **Packs:** `src/shared/locales/<locale>.json`, one flat object per language.
  - Placeholders are written `{{name}}`.
  - Plurals are `key_one` / `key_other`, using whichever categories `Intl.PluralRules` names
    for the language.
- **Source and fallback:** `en.json` is the source of every key. A missing key falls back
  to English, never to the key itself.
- **Loading:** English is imported statically. Every other pack is its own chunk, loaded
  only when that language is chosen (`import.meta.glob`).
- **Setting:** `settings.language` is `'system'` or a locale. Main keeps its own copy
  (`src/main/services/locale.ts`), refreshed on `data:save`, the same way it does for the
  local terminal switch.
- **First frame:** the renderer asks `i18n:boot` before its first render, so that render is
  already in the chosen language.
- **Out of scope:** the CLI, MCP tool text, shell commands and audit entries stay English,
  because agents and scripts parse them.
- **Guardrails:**
  - `tests/i18n.test.ts` rejects packs that have keys English does not, change placeholders,
    or contain empty strings.
  - `tests/i18nLiterals.test.ts` is a per-file ratchet on hardcoded JSX text and on the text
    of user-facing attributes.
  - The pseudo-locale `en-XA` shows strings that bypass `t()` and text that overflows. It is
    offered in development builds only.

## Alternatives

- **i18next with react-i18next.** This was the original recommendation.
  - Advantages: a mature ecosystem, and `<Trans>` for sentences that contain markup.
  - Why it lost: a new dependency for main and renderer, when the needed subset
    (interpolation, plurals, fallback, lazy packs) is about 100 lines.
  - It remains the natural upgrade: the packs are already in its format, so adopting it later
    changes only `src/shared/i18n.ts`.
- **Lingui.** Its message extraction is the best of the three libraries. It lost because its
  macros need a compile transform in three separate builds: electron-vite main, the
  renderer, and the esbuild CLI.
- **FormatJS (react-intl).** It has full ICU message syntax, but it is the largest runtime
  and its keys are not type-checked.

## Consequences

**Easier:**
- `MessageKey` is derived from `en.json`, so a mistyped key fails `typecheck`.
- One function serves main, the renderer and tests, with nothing to mock.
- Weblate and Crowdin read these packs as they are.

**Harder:**
- Sentences with markup go through `src/renderer/src/lib/Trans.tsx`, which has
  react-i18next's props but no nesting: a tag inside a tag needs splitting.
- There is no ICU `select` yet for gender or variant forms.
- English singular wording that differs from the plural in more than grammar ("Remove it"
  against "Remove all ({{count}})") cannot survive a language with no `_one` form, such as
  Chinese. Those need a separate key chosen in code.
- A string missing from a pack shows in English with no runtime warning. Coverage is
  visible only by comparing pack sizes.

**Revisit when** either of these is true; at that point adopt i18next rather than growing
this file:
- the translator needs more than `<Trans>` and a `select`, or
- a contributor workflow needs i18next-specific tooling.

**Settings search** matches the translated title and description, plus the English title and
the English aliases, so English technical terms still find a row in any language. The jump to
a row compares the row's title with the translated title of the same key.

**Rail labels** under the activity-bar icons have their own `*Rail` keys, and
`tests/activityBarLabels.test.tsx` holds every language to the width English was measured at.

## Security implications

The packs are bundled, code-signed and scanned with the rest of the release. There is no
way to load a pack from outside the bundle.

Translations are rendered as React text, never as HTML. No `dangerouslySetInnerHTML` or
`innerHTML` exists in `src/`.

A pack value can still say anything, so translated text must never be put into a command
sent to a host.

`settings.language` comes from a file on disk, so `parseLanguagePref` narrows it on both
sides.

## Supersedes

none
