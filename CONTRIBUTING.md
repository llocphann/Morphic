# Contributing to Morphic

Thanks for your interest in contributing to Morphic. The project is focused on certifying the Core V2 architecture, so correctness, reproducible benchmarks, precise lifecycle ownership, source provenance, and release hygiene take priority over isolated micro-optimizations.

## Development setup

### Prerequisites

- Node.js **22**
- npm **11.6.0** through the repository runner
- An Obsidian vault for live testing

### Getting started

1. Clone the repository into a development directory or directly into a Morphic plugin folder.
2. Install dependencies without generating a repository lockfile during the current pre-release phase:

   ```bash
   node scripts/pinned-npm.mjs install --ignore-scripts --no-package-lock
   ```

3. Start the development build:

   ```bash
   node scripts/pinned-npm.mjs run dev
   ```

4. For a live Obsidian install, use a plugin directory named `morphic` so it matches the manifest ID.

`scripts/pinned-npm.mjs` downloads and invokes npm 11.6.0 directly. Certification does not rely on the npm version bundled with a particular Node 22 point release. The final lockfile/reproducibility policy is an explicit release gate; see `docs/release/FINAL_RELEASE_CHECKLIST.md`.

## Available scripts

The examples below use `NPM="node scripts/pinned-npm.mjs"` conceptually; invoke the runner explicitly in shell commands.

| npm script | What it does |
| --- | --- |
| `run dev` | Watch mode — rebuild on changes |
| `run build` | Type-check and create a production bundle |
| `run lint` | Run ESLint |
| `run lint:fix` | Run ESLint with automatic fixes |
| `test` | Run the full Vitest suite once |
| `run test:watch` | Run tests in watch mode |
| `run test:coverage` | Run the suite with coverage |
| `run check:release-metadata` | Validate package/manifest/versions/package-manager metadata |
| `run check:repo-hygiene` | Reject obsolete integration artifacts/markers |
| `run audit:provenance` | Triage source similarity against frozen Custom Views 0.4.0 |
| `run bench:compiler` | Run compiler benchmarks |
| `run bench:core` | Run Core V2 certification benchmarks |
| `run bench:release` | Run repository microbenchmark suites |
| `run bench:competitive -- --help` | Inspect the live Morphic vs Custom Views 0.4 harness |

## Project structure

```text
src/
  main.ts                    # Obsidian plugin entry point and production wiring
  core/                      # reactive data, revisions, invalidation and lifecycle primitives
  compiler/                  # compiled rules, expressions, templates and dependency metadata
  settings.ts                # settings entry point
  settings-core.ts           # canonical settings/editor/filter implementation
  settings-preset-ui.ts      # Morphic compact View preset workspace
  renderer.ts                # production rendering surface
  retained-*.ts              # retained / transactional rendering ownership modules
  editor.ts                  # CodeMirror template editor
  editor-language-completions.ts
  editable-content.ts        # Live Preview editable content integration
  suggests.ts                # vault-aware suggestion providers
  bases/                     # Bases adapter, isolation and caching
  __tests__/                 # Vitest regression and certification coverage
  __benchmarks__/            # compiler/Core microbenchmarks
```

Key repository files:

- `README.md` — current product and release status
- `CHANGELOG.md` — candidate changes and eventual release notes
- `manifest.json` — Obsidian plugin manifest
- `styles.css` — plugin stylesheet
- `versions.json` — plugin version to minimum Obsidian version mapping
- `scripts/pinned-npm.mjs` — pinned npm 11.6.0 runner used by certification
- `scripts/competitive-benchmark.mjs` — live competitive benchmark harness
- `scripts/provenance-audit.mjs` — reproducible source-similarity triage
- `scripts/check-release-metadata.mjs` — release metadata validator
- `scripts/repository-hygiene.mjs` — repository convergence guard
- `docs/CORE_V2.md` — current runtime architecture and invariants
- `docs/performance/competitive-custom-views-0.4.0.md` — competitive benchmark protocol
- `docs/provenance/CUSTOM_VIEWS_0.4.0_AUDIT.md` — upstream-removal/source provenance gate
- `docs/release/FINAL_RELEASE_CHECKLIST.md` — authoritative release checklist
- `LICENSE` — GPL-3.0-only license for Morphic-authored code
- `LICENSE-MIT-ORIGINAL` and `NOTICE` — retained while upstream provenance is not yet fully cleared

## Contribution priorities

High-value pre-release contributions generally fall into these areas:

1. Correct render ownership, stale-work cancellation, and resource cleanup.
2. Precise invalidation and zero-work/no-op paths.
3. Compiler/runtime correctness without repeated parsing.
4. Cross-file data freshness and revisioned caching.
5. Retained rendering with transaction/currentness guarantees.
6. Bases reliability, isolation, and cache invalidation.
7. Settings/editor behavior and Obsidian compatibility.
8. Direct competitive benchmark evidence against Custom Views 0.4.0.
9. Source-provenance cleanup for any remaining derived implementation.

## Correctness requirements

Every candidate change must preserve capability and lifecycle semantics. At minimum, the exact commit intended for integration should pass under Node 22 + npm 11.6.0:

```bash
node --check scripts/pinned-npm.mjs
node scripts/pinned-npm.mjs --version
node scripts/pinned-npm.mjs run check:repo-hygiene
node scripts/pinned-npm.mjs run check:release-metadata
node scripts/pinned-npm.mjs run build
node scripts/pinned-npm.mjs test
node scripts/pinned-npm.mjs run lint
git diff --check
```

If a change affects repository harnesses, run the appropriate `node --check` command as well. Changes involving actual Obsidian DOM/layout, Live Preview, Canvas, Bases, or plugin lifecycle require a real-Obsidian smoke or benchmark in addition to unit tests.

## Performance contribution rules

A performance change needs equivalent-workload evidence.

- Use the same input data and user-visible behavior for both sides of a comparison.
- Report raw measurements and p50/p95/p99 where the workload supports repeated samples.
- Do not claim end-to-end speedups from subsystem-only microbenchmarks.
- Do not hide a meaningful loss behind an aggregate score.
- Do not weaken capability, cache boundaries, or currentness semantics to improve a benchmark.
- Track CPU/memory/resource lifetime where measurement is reliable.

The competitive release target is the frozen Custom Views 0.4.0 baseline documented in `docs/performance/competitive-custom-views-0.4.0.md`.

## Source provenance

Morphic's final repository is intended to contain an independently maintained Core V2 implementation. A changed filename or Git blob is not enough to prove a file is independent of upstream expression.

When touching an area marked `DERIVED` or `UNCERTAIN` in the provenance audit:

1. compare it against the frozen upstream 0.4.0 source;
2. avoid copying implementation text merely to preserve behavior;
3. prefer a fresh implementation against Morphic's current architecture/contracts;
4. update the provenance audit with evidence;
5. do not remove the upstream MIT notice until the release tree has been certified clear or retained material is intentionally attributed.

## Submitting changes

1. Branch from `main`.
2. Make focused changes.
3. Add or update regression tests.
4. Run the relevant Node 22/npm 11.6.0 correctness gates.
5. Attach benchmark evidence for performance changes.
6. Call out lifecycle, compatibility, migration, and provenance implications in the pull request.

## Code style

- Keep lifecycle ownership explicit and scoped.
- Prefer idempotent, cancellable work and precise invalidation.
- Use registered/disposable listeners and observers.
- Avoid global polling when an event-driven path exists.
- Avoid reparsing invariant view/template state on hot paths.
- Preserve last-known-good/current surfaces until replacement work is valid to commit.
- Keep user-facing Settings text in Obsidian sentence case.
- Do not introduce remote-code execution or network dependencies without a clear product requirement and explicit review.

## Release discipline

A tag is not release-ready merely because it builds. The final candidate must close correctness, reliability, direct competitive performance, real-Obsidian smoke, packaging metadata, dependency reproducibility, and provenance gates. The release workflow intentionally creates a **draft** release so the generated artifact can be verified before publication.

## Licensing

Contributions to Morphic-authored code are accepted under **GPL-3.0-only**. Upstream MIT attribution remains preserved while the source-provenance audit is incomplete.
