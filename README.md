# Morphic

**Programmable, reactive views for Obsidian.**

Morphic turns Markdown notes into rich, programmable interfaces while keeping the underlying vault as ordinary Markdown. A view can match notes by metadata and structure, render custom HTML, evaluate expressions, embed Obsidian Bases data, apply scoped CSS, run trusted local JavaScript, and remain fresh as the vault changes.

The runtime is built around a simple performance principle:

> **Unchanged data should cause no work. Changed data should update only what actually changed.**

## Why Morphic

Morphic is designed for vaults where a custom view is more than a static template. It treats each rendered surface as an owned, revision-aware transaction and tracks the data that surface actually consumes. This lets the runtime invalidate precisely, reject stale asynchronous work, retain safe rendered structure, and avoid unnecessary full refreshes.

Core strengths include:

- **Reactive data flow** — file bodies, metadata, tags, folders, linked-note properties, settings, Bases sources and volatile inputs are tracked as explicit dependencies.
- **Precise invalidation** — changes target affected render owners instead of blindly rebuilding every view.
- **Currentness guarantees** — outdated asynchronous renders cannot commit after navigation or newer generations supersede them.
- **Retained rendering** — stable structure is reused when safe while dynamic regions update independently.
- **Live Preview freshness** — unsaved editor content can participate in custom rendering without waiting for a disk write.
- **Cross-file reactivity** — views that consume linked-note data refresh when the linked source changes.
- **Event-driven Canvas support** — Canvas nodes are scheduled by dirty events rather than periodic whole-canvas polling.
- **Bases integration** — native Bases collection is isolated behind revision-aware cache and lifetime boundaries.
- **Programmable templates** — HTML templates, expressions, conditions, loops, variables, filters, Markdown rendering and optional trusted local JavaScript.
- **Native-feeling configuration** — view presets, filter editing, property-aware suggestions, navigation controls and editor completions integrate with Obsidian workflows.

## Capabilities

Morphic 0.1.0 supports:

- matching notes by metadata, folders, tags, links and frontmatter;
- HTML templates with placeholders and filters;
- expressions, variables, conditions and loops;
- wikilink and Markdown rendering through Obsidian;
- linked-note property resolution;
- embedded Obsidian Bases data;
- scoped per-view CSS;
- optional trusted local JavaScript;
- Reading view and Live Preview;
- editable `{{file.content}}` workflows;
- Canvas-node custom views;
- native-style filter editing;
- vault-aware property suggestions;
- HTML, CSS and JavaScript completion in editors.

## Architecture

Morphic Core V2 is organized around seven runtime systems:

1. **Render ownership** — each Markdown leaf or Canvas node owns an independent controller, generation and disposable render scope.
2. **Compiled views** — matcher predicates, template structure, expressions, filters and dependency metadata are compiled and cached by revision.
3. **Reactive dependency graph** — every render records the resources it actually consumes.
4. **Revisioned data layer** — normalized vault data, lazy body materialization, query caches and dependency revisions provide deterministic freshness boundaries.
5. **Transactional retained renderer** — prepared work must still own the current generation before it can commit to the DOM.
6. **Bases adapter/cache** — expensive Bases collection is isolated with caching, invalidation, in-flight coordination and lifetime cleanup.
7. **Canvas dirty scheduler** — event-driven scheduling coalesces node work and avoids periodic full rendering.

For deeper implementation details, see [`docs/CORE_V2.md`](docs/CORE_V2.md).

## Installation

### Manual installation

Build Morphic, then place these files in:

```text
<Vault>/.obsidian/plugins/morphic/
```

Required plugin artifacts:

```text
main.js
manifest.json
styles.css
```

Then reload Obsidian and enable **Morphic** under **Settings → Community plugins**.

## Development

Requirements:

- Node.js **22.x**
- npm **11.6.0** through the repository's pinned npm runner
- Obsidian for live integration testing

Install dependencies and run the main checks with:

```bash
node scripts/pinned-npm.mjs install --ignore-scripts --no-package-lock
node scripts/pinned-npm.mjs run check:repo-hygiene
node scripts/pinned-npm.mjs run check:release-metadata
node scripts/pinned-npm.mjs run build
node scripts/pinned-npm.mjs test
node scripts/pinned-npm.mjs run lint
```

Additional benchmark and provenance tooling is available under `scripts/` and `src/__benchmarks__/`.

## Performance model

Morphic is optimized for sustained reactive workloads rather than treating every update as a fresh full render. The runtime combines compiled plans, dependency revisions, retained surfaces, no-op detection, owner-local scheduling and cache-aware data access.

Performance work remains evidence-driven: important paths are measured with repeated warmup/sample runs, semantic checksums, percentile reporting and real-Obsidian integration workloads. Version 0.1.0 is the first public development release; optimization of cold-start and cold-render paths continues on the development line.

## Security

Template JavaScript runs locally inside Obsidian and should only be enabled for templates you trust. JavaScript execution can be disabled when a view only needs HTML, CSS, expressions and native Obsidian rendering.

## License

Morphic-authored code is distributed under **GPL-3.0-only**.

Copyright © 2026 Lộc Phan.
