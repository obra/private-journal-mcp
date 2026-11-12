# Changelog

## [2.0.2] - 2026-11-12

### Fixed

- Journal entries that failed to embed were silently reported as indexed, so they never showed up in `search_journal` or `list_recent_entries` until an unrelated read happened to reconcile them. `writeThoughts` and the read-time backfill now report indexing failures and retry once before giving up (#29).
- Project and user journals that resolve to the same directory (e.g. via `PRIVATE_JOURNAL_PATH`, or running from the home directory) no longer double-write and double-index every entry (#27, thanks @AndrewSpell).

### Changed

- The MCP `initialize` handshake no longer blocks on embedding model warm-up, so the server responds immediately even on a cold model cache; missing embeddings are now backfilled in the background after startup (#22).
- Dependency updates: `@types/node`, `prettier`, and `typescript` bumped to their latest non-major releases; `npm audit fix` applied for the `tar-fs` symlink validation bypass (GHSA-vj76-c3g6-qr5v).

### Added

- `.claude-plugin/plugin.json` so the Claude Code plugin marketplace can validate this package as a plugin (#25).
- `.github/workflows/publish.yml`: tagging a `v*` release now runs the build and test suite and publishes to npm automatically via npm's trusted-publishing (OIDC) flow, no long-lived `NPM_TOKEN` secret required.

## [2.0.1] - 2026-06-12

### Fixed

- ESLint configuration now loads under `"type": "module"` (`.eslintrc.js` →
  `.eslintrc.cjs`, corrected `extends`), and the pre-existing lint errors it
  surfaced are cleared (unused imports; `error as any` → `error as NodeJS.ErrnoException`).

## [2.0.0] - 2026-04-11

### Why this release

The `feelings` field on `process_thoughts` signaled too narrowly. Agents using it interpreted the name as "emotional processing only," so entries that integrated thinking, noticing, and emotional processing landed nowhere clean — and that integrated form is what most journal entries actually are. Renaming the field to `reflections` with a broadened description gives those entries an obvious home.

A new `observations` field fills a separate gap: short, one-or-two-sentence noticings ("I noticed X.", "Y keeps coming up.") that don't belong in a longer reflection but are worth searching back for later.

This release also removes the obsolete `process_feelings` tool. It was hidden from tool discovery in May 2025 when `process_thoughts` replaced it but its handler was kept "for backwards compatibility." Keeping a hidden tool literally called `process_feelings` while the schema is broadening *away* from "feelings" was incoherent, and consistent with the no-alias decision for the field rename.

### Breaking changes

- **`feelings` field renamed to `reflections`** on `process_thoughts`. No alias. Callers sending `feelings` will be rejected with "At least one thought category must be provided." Existing on-disk markdown files with `## Feelings` headers are intentionally untouched and remain searchable via `search_journal` with `sections: ['feelings']`.
- **`process_feelings` tool removed.** The tool was hidden from tool discovery in May 2025 but its handler was kept for backward compatibility. Now removed. Callers that knew the undocumented name will get "Unknown tool: process_feelings".
- **`JournalManager.writeEntry` removed** along with its solely-owned `formatEntry` helper. The only caller was the dead `process_feelings` handler.

### Added

- **`observations` field** on `process_thoughts` for short, discrete noticings. Routes to the user-global journal alongside `reflections`. Renders as `## Observations` between `## Reflections` and `## Project Notes`.
- **Broadened `reflections` description** covering "integrated thinking — what you noticed, felt, understood, or processed."

### Removed

- Dead `process_feelings` request handler in `src/server.ts`
- `ProcessFeelingsRequest` interface in `src/types.ts`
- `JournalManager.writeEntry` method and `formatEntry` helper in `src/journal.ts`
- Six `writeEntry` tests in `tests/journal.test.ts`
- Stale "single `process_feelings` tool" architecture descriptions in `CLAUDE.md`

### Changed

- `process_thoughts` tool-level description and `search_journal` `sections` filter example updated to use the new field names
- `package.json` description updated from "process feelings and thoughts" to "private journaling and reflection capability"
- README and CLAUDE.md updated to describe the new field set

### Coverage

- Re-homed three test assertions onto the live `writeThoughts` code path that were previously only exercised through the deleted `writeEntry` tests: microsecond filename precision, YAML frontmatter line-by-line structure, and same-day filename collision avoidance.

## [1.2.0] - 2026-04-09

### Added
- `read_recent_entries` tool for reading the full content of the N most recent journal entries (complements `list_recent_entries`, which returns only metadata and excerpts)

## [1.1.0] - 2026-04-06

### Added
- `PRIVATE_JOURNAL_PATH` environment variable to override all journal storage to a single directory, for containerized deployments (#8 related)
- 30-second timeout on embedding model initialization to prevent server hangs from stale lock files (#5)

### Fixed
- Migrated from CommonJS to ESM output, fixing `tools/list` returning empty on Node.js 22+ due to CJS/ESM dual-package hazard (#18)
- Fixed test expectations for embedding file generation (file count and semantic search assertions)

### Changed
- `jest.config.js` renamed to `jest.config.cjs` (required by ESM migration)
- TypeScript target updated from ES2020 to ES2022 with NodeNext module resolution

## [1.0.0] - 2025-05-28

Initial release with multi-section journaling, semantic search, and dual project/user storage.
