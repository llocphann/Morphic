# Morphic source provenance audit against Custom Views 0.4.0

Status: **IN PROGRESS — attribution removal is not yet certified**

This document tracks whether the final Morphic release tree still contains copyrightable expression inherited from Custom Views 0.4.0. It is a source-provenance gate, separate from functional correctness and performance certification.

## Frozen upstream baseline

- Repository: `anupchavan/obsidian-custom-views`
- Release: `0.4.0`
- Source commit: `1d9f2e99c3bfcc82dd9d657ead65fffadbdac0f5`
- Annotated tag object: `c2c2612aaa0faab6b5455ea3faf9ecf4bb10a867`
- Release `main.js` SHA-256: `7055eb74f42a2525e816945a212f89089909da4ef5aa6da1d5e41f67e8a8e998`
- Release `manifest.json` SHA-256: `1f009e66b60ce708f5fcbf5f847626b17457b5b0da51f372442341d7eb774368`
- Release `styles.css` SHA-256: `2ac648e2c4dc6dbe216b6119bdf5c345e2222c4b257401ae6c2ae8d871a1cc1a`

## Classification rules

- **ORIGINAL** — Morphic implementation with no copied upstream expression identified.
- **DERIVED** — known to retain or adapt upstream implementation text/structure.
- **UNCERTAIN** — changed from upstream but not yet sufficiently reviewed to certify independent expression.
- **TRIVIAL/INFRA** — generic repository configuration; not runtime product source.
- **RETAIN** — attribution/license material intentionally kept until all material DERIVED/UNCERTAIN runtime content is resolved.

A different Git blob SHA proves only that a file is not byte-for-byte identical. It does **not** by itself prove independent authorship.

## Reproducible triage

Run:

```bash
npm run audit:provenance
```

The harness in `scripts/provenance-audit.mjs` checks the exact frozen upstream commit and compares auditable source by exact digest plus token-shingle similarity, including possible renamed-file matches. It emits `EXACT`, `REVIEW_HIGH`, `REVIEW_MEDIUM`, `REVIEW_LOW`, and trivial-review candidates.

The result is a **triage signal, not a legal conclusion**. Material `EXACT`, `REVIEW_HIGH`, and `REVIEW_MEDIUM` candidates require human review before attribution can be removed.

## Current evidence

### New Morphic architecture

| Area | Status | Evidence / action |
| --- | --- | --- |
| `src/core/**` | ORIGINAL | Core V2 reactive data, revision tracking, invalidation, currentness, ownership, and lifecycle architecture is Morphic-specific and has no corresponding upstream directory at the frozen baseline. |
| `src/compiler/**` | ORIGINAL | Morphic compiler/IR pipeline is a new directory and architecture relative to the frozen upstream tree. |
| retained rendering / ownership modules introduced for Core V2 | ORIGINAL | Added for Morphic's retained/transactional owner model; preserve regression coverage as engineering provenance evidence. |
| `src/assigned-property-type-invalidation.ts` | ORIGINAL | Morphic-specific production invalidation module. |
| `src/editor-language-completions.ts` | ORIGINAL | Morphic implementation added for editor capability coverage. |
| `src/cv04-capability-adapter.ts` | ORIGINAL | Compatibility adapter written for Morphic; behavioral compatibility does not itself imply copied expression. |
| `src/settings-preset-ui.ts` | ORIGINAL | Morphic compact preset workspace and navigation behavior. |

### Shared product layer requiring source review

The following are deliberately not certified merely because their current blobs differ from upstream. The audit harness must review the entire auditable tree, not only this table.

| File / area | Evidence | Status |
| --- | --- | --- |
| `src/editable-content.ts` | current blob differs from upstream `525f1f5906536cd99d71d9989e5ebf476d9802ae` | UNCERTAIN |
| `src/editor.ts` | current blob differs from upstream `b2d802f3fd60d911fe1aa051da52bf38e7158ecf` | UNCERTAIN |
| `src/expression.ts` | current blob differs from upstream `3c0122a04a33163906ccf1a86da5a970ed1b5e1c` | UNCERTAIN |
| `src/filters.ts` | current blob differs from upstream `64f305dd5714c231e1b60972ad0e6481f0d67ed6` | UNCERTAIN |
| `src/frontmatter.ts` | current blob differs from upstream `f1f843e88e8ef24204693fce3c5fd265d0d43961` | UNCERTAIN |
| `src/main.ts` | current blob differs from upstream `06a937d8817102d3cc176df148588341347c3352` | UNCERTAIN |
| `src/matcher.ts` | production implementation now delegates into Morphic compiler architecture, but retains a shared product responsibility | UNCERTAIN pending similarity review |
| `src/renderer.ts` | substantially reworked production role, but shared lineage remains possible | UNCERTAIN pending similarity review |
| `src/suggests.ts` | settings/suggestion product behavior may share upstream design or expression | UNCERTAIN pending similarity review |
| `src/types.ts` and other shared-name product files | must be covered by whole-tree triage | UNCERTAIN pending similarity review |
| `src/bases/**` | Morphic tree differs from frozen upstream Bases tree, but shared lineage remains possible | UNCERTAIN |
| `src/settings-core.ts` | canonical settings logic was retained from the pre-split Morphic settings implementation | DERIVED/UNCERTAIN |
| `styles.css` | modified Morphic stylesheet with upstream lineage possible | DERIVED/UNCERTAIN |
| `__mocks__/obsidian.ts` | modified mock with upstream lineage possible | UNCERTAIN |

### Repository and dead-artifact cleanup

Repository-side cleanup completed before local certification:

- inherited upstream `AGENTS.md` removed;
- obsolete `HANDOFF.md`, bot-era integration docs, and historical P7 evidence removed from the release tree;
- `.editorconfig`, `.gitignore`, and `.npmrc` replaced with Morphic-specific policy;
- obsolete Rusty Engine/WASM declaration file `src/wasm.d.ts` removed after the runtime dependency/path had already been deleted;
- `scripts/repository-hygiene.mjs` now prevents these obsolete artifacts and historical branch/repository markers from returning to `main`;
- generated provenance evidence, `.codex/`, `main.js`, and the currently-unreviewed local lockfile are excluded by repository policy.

These cleanup changes reduce inherited repository scaffolding and dead material but do not determine whether shared runtime code still requires attribution.

### License/notice files

| File | Status | Rule |
| --- | --- | --- |
| `LICENSE` | RETAIN | Morphic license for Morphic-authored code. |
| `LICENSE-MIT-ORIGINAL` | RETAIN | Must remain while substantial upstream MIT material may still be present. |
| `NOTICE` | RETAIN | Documents derivative status while provenance audit is incomplete. |

Do **not** remove `LICENSE-MIT-ORIGINAL` or upstream-related `NOTICE` text merely because Git history, branches, filenames, or architecture changed.

## Required closure work before attribution can be removed

1. Run the provenance harness on the exact candidate commit.
2. Manually inspect every `EXACT`, `REVIEW_HIGH`, and material `REVIEW_MEDIUM` candidate against upstream commit `1d9f2e99c3bfcc82dd9d657ead65fffadbdac0f5`.
3. For each material retained implementation fragment, either:
   - rewrite it independently while preserving public behavior, or
   - keep the upstream MIT attribution for the final release.
4. Re-run the audit after rewrites so the **release tree**, not an earlier development tree, is what gets certified.
5. Review non-TypeScript material too: CSS, build scripts, mocks, tests/assets if promoted into the release repository, and any copied documentation.
6. Only after all material runtime candidates are independently authored or otherwise cleared may the project consider removing `LICENSE-MIT-ORIGINAL` and derivative language from `NOTICE`.

## Release gate

Attribution removal status: **BLOCKED pending reproducible audit + human review**

This block is source-provenance/legal only. It does not prevent correctness, performance, packaging, or Obsidian smoke certification from proceeding in parallel.
