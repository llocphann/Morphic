# Changelog

All notable Morphic changes will be documented here.

## 0.1.1 — 2026-09-11

### Fixes

- Replaced the benchmark-only synthetic `TFile` cast and forbidden ESLint suppression with a typed `TFile` fixture.
- Removed the two Obsidian source-code lint blockers reported for `src/__benchmarks__/compiler.bench.ts` without changing production runtime behavior.

### Release automation

- Release version changes on `main` are now fully gated by repository hygiene, metadata validation, build, tests, lint, diff checks, checksums, and provenance attestation before publishing the exact manifest version.

## 0.1.0 — 2026-09-10

### Core V2 architecture

- Replaced the legacy global render model with per-owner render controllers, generation/currentness checks and disposable render scopes.
- Added reactive dependency tracking, revisioned data, precise invalidation and zero-work/no-op paths.
- Added compiled matcher, expression, template and filter pipelines with dependency metadata and revision-aware caching.
- Added retained/transactional rendering, prepared-island ownership and keyed reconciliation.
- Reworked Markdown/Live Preview ownership and stale-work rejection.
- Reworked Canvas into event-driven per-view/per-node dirty scheduling and lifecycle cleanup.
- Added Bases isolation, caching, invalidation and reliability protections.

### Product and editor

- Added compact Morphic View presets (`View 1`, `View 2`, …) with add, rename, reorder, edit and delete operations.
- Added tab semantics and keyboard navigation for View presets on the Obsidian 1.13+ Settings API.
- Restored the explicit `General` Settings section after the View workspace.
- Added Morphic funding metadata and a Settings support control.
- Moved Morphic-specific Settings presentation into `styles.css` instead of inline JavaScript styling.
- Added/expanded HTML, CSS and JavaScript editor completion support.
- Preserved Reading view, Live Preview, editable content, Canvas, per-view CSS, trusted local JavaScript and embedded Bases capability targets.

### Performance and certification

- Added direct black-box live Obsidian competitive benchmarking against frozen Custom Views 0.4.0 artifacts.
- Added compiler/Core V2 benchmark suites and broad currentness/lifecycle/Bases/Canvas reliability regressions.
- Standardized CI and release certification on Node 22 and aligned Node development typings to the Node 22 line.
- Pinned certification tooling to npm 11.6.0 and added a repository-owned npm runner so Node 22 point releases do not silently change the dependency resolver used for certification.
- Avoided npm 10.9.8 for certification after its Arborist peer-set resolver crashed before normal dependency error reporting.
- Added regression coverage for pinned package-manager metadata and runner identity.
- Added repository-convergence and release-metadata guards to both CI and release workflows.
- Hardened release metadata validation against Obsidian Community plugin manifest/version/tag requirements.
- Added SHA-256 artifact checksums and build provenance attestation.
- Release workflow creates a draft release so the generated artifact can be smoke-tested before publication.

### Repository and provenance

- Converged development/release source onto `main`.
- Removed inherited upstream `AGENTS.md`, obsolete engineering `HANDOFF.md`, bot-era integration notes and historical P7 evidence from the release tree.
- Removed obsolete Rusty Engine/WASM declarations after the runtime path had been deleted.
- Replaced inherited generic EditorConfig, gitignore and npm configuration with Morphic-specific policy.
- Added `scripts/repository-hygiene.mjs` to reject obsolete branch-era artifacts and markers from the release tree.
- Added a current documentation index and replaced the stale migration roadmap with the production Core V2 architecture contract.
- Added a reproducible source-provenance triage harness against frozen Custom Views 0.4.0 source.
- Retained the upstream MIT license notice while material product-layer provenance remains under review.
- Removed the temporary `Morphic-test` discussions URL from issue-template configuration so a clean snapshot is not coupled to the staging repository name.

### Versioning and packaging

- Fixed version metadata generation so every selected release version is recorded in `versions.json`.
- Added regression coverage for missing version input and unchanged `minAppVersion` version bumps.
- Marked the package private to prevent accidental npm publication and made Node 22 plus npm 11.6.0 explicit package-engine requirements.
- Added a final release checklist covering dependency reproducibility, compatibility floor, provenance, competitive performance, artifact verification and clean transfer to the final `Morphic` repository.

### Pending before release

- Fresh clean Node 22/npm 11.6.0 repository-hygiene/metadata/build/full-test/lint/diff certification on the exact candidate commit.
- Run and review the source-provenance audit; independently rewrite material inherited expression or intentionally retain attribution.
- Direct competitive measurements with no important loss versus Custom Views 0.4.0.
- Real Obsidian smoke testing for Settings, Live Preview, linked notes, Canvas, Bases, completion, lifecycle, compatibility floor and reopen behavior.
- Review a clean Node 22/npm 11.6.0 dependency resolution and make the final lockfile/reproducibility decision.
- Final version selection and metadata bump.
- Transfer the certified clean snapshot to the final `Morphic` repository.
- Verification of the generated release artifact before publishing the draft release.
