# Morphic Core V2

Morphic Core V2 is the production architecture for programmable Obsidian views. The rewrite replaces file-global scheduling and repeated full-surface work with owner-scoped rendering, reactive data, compiled view programs, retained DOM, and precise invalidation.

The governing rule is:

> **Unchanged data should cause no work. Changed data should update only what actually changed.**

## Status

Implementation is integrated on `main`. The remaining release work is certification rather than architectural migration:

- fresh Node 22 build/test/lint/diff certification;
- direct live comparison with the frozen Custom Views 0.4.0 baseline;
- source-provenance review of shared product-layer code;
- real Obsidian smoke testing;
- final versioning, artifact verification, and publication.

See `docs/release/FINAL_RELEASE_CHECKLIST.md` for the authoritative release gates.

## Non-negotiable invariants

1. **One owner, one render authority.** Markdown panes and Canvas nodes own independent render lifecycles.
2. **Only current work may commit.** Async preparation is generation-scoped; stale work cannot mutate the live surface.
3. **Last known-good surfaces survive failed/stale work.** Navigation and rendering failures do not silently blank a valid view.
4. **Resources have explicit lifetimes.** Listeners, observers, child components, cancellation handles, prepared islands, and committed render resources belong to disposable owner scopes.
5. **Cache validity is dependency-based.** A file path alone is never a sufficient cache key.
6. **Invalidation is precise.** Metadata, body, linked-file, settings, Bases, property, tag-family, and volatile dependencies advance independently where semantics allow it.
7. **Canvas is event-driven.** Production rendering must not regress to periodic full-node polling.
8. **Invariant syntax is compiled once per revision.** Rules, expressions, filters, and templates are not reparsed on every warm render.
9. **Retained DOM is authoritative only when ownership is valid.** Incremental rendering must never trade correctness for fewer DOM mutations.
10. **Performance evidence is apples-to-apples.** Subsystem microbenchmarks can explain results but cannot substitute for live end-to-end comparison.

## Architecture

### Render ownership and currentness

`RenderController`, `RenderScope`, owner registries, retained owner hosts, and generation coordinators provide per-surface authority. Preparation may happen asynchronously and off-surface; commit is allowed only after final generation and owner-validity checks.

This model covers Reading view, Live Preview, editable content, navigation handoff, and Canvas node rendering. Same-file panes remain independent owners.

### Reactive data and invalidation

The Core V2 data layer tracks revisions and actual read dependencies rather than treating every vault event as a full refresh.

Key responsibilities include:

- file snapshots with lazy body materialization;
- metadata/body/stat distinctions;
- linked-file/property-chain tracking;
- property catalog and file-data dependencies;
- tag-family and Bases-query dependencies;
- settings data sources;
- time/volatile dependencies;
- revision fingerprints, compaction, and lifecycle reclaim;
- reverse dependency lookup from changes to affected owners.

No-op refreshes should preserve identities and avoid allocations or scheduling wherever observable semantics are unchanged.

### Compiled view programs

The compiler layer turns view configuration into reusable execution structures:

- compiled rule predicates;
- expression classification and compiled evaluation;
- compiled filter pipelines;
- template IR and structural plans;
- attribute-part plans;
- dependency hints and volatility classification;
- per-view revision caching.

Warm execution must not repeatedly parse invariant syntax.

### Retained and transactional rendering

The render layer combines detached preparation with retained ownership. It supports static retained surfaces, typed dynamic slots, conditional/loop transactions, keyed ranges, raw-HTML ranges, Markdown islands, editable hosts, and structural reconciliation.

The renderer may reuse DOM only while the corresponding owner/generation/dependency state remains valid. Stale or invalid prepared work is discarded rather than committed.

### Bases isolation

Bases integration is behind Morphic-owned access/provider boundaries. Query/result work is revision-aware, cacheable, deduplicated where equivalent, and invalidated through tracked dependencies. Internal Obsidian failures must remain contained within the adapter boundary rather than corrupting render ownership.

### Settings and product surface

The release product surface includes:

- compact `View 1`, `View 2`, … presets;
- add, rename, reorder, edit, and delete actions;
- keyboard-accessible preset navigation;
- native-style filter editing;
- vault-aware property/value suggestions;
- HTML/CSS/JavaScript editor completion;
- Reading view and Live Preview behavior;
- editable `{{file.content}}`;
- Canvas and Bases support;
- optional trusted local JavaScript.

Settings mutations participate in the same invalidation/currentness model as vault data.

## Correctness contract

Release certification must demonstrate at minimum:

- no stale async commits during rapid A → heavy B → C navigation;
- no concurrent commit authority for the same owner;
- unsaved Live Preview source remains current;
- linked-note and cross-file data updates invalidate the correct owners;
- metadata-only updates do not force unnecessary body reads;
- Canvas owner cleanup releases resources and does not idle-rerender;
- Bases cold/warm paths remain isolated and semantically equivalent;
- settings changes invalidate the appropriate caches and views;
- plugin disable/re-enable and unload/reload do not retain detached resources.

## Performance contract

The final competitive baseline is **Custom Views 0.4.0**, frozen at source commit `1d9f2e99c3bfcc82dd9d657ead65fffadbdac0f5`.

The live benchmark must use equivalent fixtures, semantics, cache boundaries, environment, warmup, and sample counts. Important workloads include startup/init, first and warm render, repeated navigation, no-op refresh, metadata/body/linked updates, expression/loop workloads, Bases cold/warm, filter-heavy workloads, Canvas 1/10/50/100 nodes, rapid-currentness work, and resource lifetime.

Report p50/p95/p99 independently. Morphic is not release-qualified while an important apples-to-apples metric has an unexplained material loss.

See `docs/performance/competitive-custom-views-0.4.0.md` for the benchmark protocol.

## Source provenance

Core V2 and compiler architecture are Morphic-specific implementation areas, but the repository originated as a fork and some shared product-layer files may still contain inherited expression. A changed filename or blob hash is not sufficient proof of independent authorship.

The source-provenance gate is tracked in `docs/provenance/CUSTOM_VIEWS_0.4.0_AUDIT.md`. Upstream MIT attribution remains until that audit is closed or the remaining inherited material is independently rewritten.

## Release boundary

The release artifact consists of:

- `main.js`;
- `manifest.json`;
- `styles.css`;
- release checksums/provenance generated by the release workflow.

The final release should be tagged from a certified `main` commit. The eventual public `Morphic` repository may be created from a clean certified snapshot; repository history cleanup does not replace source-provenance or license review.
