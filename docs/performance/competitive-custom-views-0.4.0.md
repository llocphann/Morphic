# Competitive performance qualification — Custom Views 0.4.0

Status: **HARNESS_IMPLEMENTED / MEASUREMENT_PENDING**

This is the release-blocking competitive baseline for Morphic. Older P7 evidence compared Morphic legacy with Core V2 rather than Morphic with Custom Views 0.4.0; it has therefore been removed from the release tree and must not be used as competitive release proof.

## Frozen competitor

- Repository: `anupchavan/obsidian-custom-views`
- Release: `0.4.0`
- Annotated tag object: `c2c2612aaa0faab6b5455ea3faf9ecf4bb10a867`
- Source commit: `1d9f2e99c3bfcc82dd9d657ead65fffadbdac0f5`
- Release `main.js` SHA-256: `7055eb74f42a2525e816945a212f89089909da4ef5aa6da1d5e41f67e8a8e998`
- Release `manifest.json` SHA-256: `1f009e66b60ce708f5fcbf5f847626b17457b5b0da51f372442341d7eb774368`
- Release `styles.css` SHA-256: `2ac648e2c4dc6dbe216b6119bdf5c345e2222c4b257401ae6c2ae8d871a1cc1a`

The live harness rejects a Custom Views installation whose release identity/digest does not match the frozen baseline. For Morphic it compares the installed vault bundle digest with the freshly built repository `main.js` and records the repository HEAD.

## Boundary

`scripts/competitive-benchmark.mjs` executes both products as installed Obsidian plugins in the same vault and the same Obsidian/Electron renderer boundary. It creates an isolated fixture folder, applies equivalent settings semantics to both products, disables the competing plugin while one lane is measured, verifies semantic output, and restores settings/plugin runtime state afterward.

Live v2 separated Obsidian's persisted plugin enablement from actual renderer-process load state. Lifecycle setup, unload/re-enable samples, verification, and restoration use `app.plugins.plugins[id]` as the runtime-loaded predicate; `enabledPlugins` is not used as a proxy for whether plugin code is currently loaded. This prevents a transiently loaded plugin from turning startup samples into `enablePlugin()` no-ops merely because it remains disabled in persisted settings.

Live v3 adds a deterministic Markdown view boundary. Every Markdown navigation performed by the harness is pinned to Reading/Preview mode with `WorkspaceLeaf.setViewState(...)`, `mode: "preview"`, and `source: false` before semantic readiness is accepted. `readyOverlay()` also rejects Markdown states outside the pinned mode. The result environment records `markdownMode`, `markdownSource`, and `markdownModeEnforcement`, and the comparator requires those fields to match across Morphic and Custom Views lanes. The benchmark restores the original active leaf view state after the run.

Live v1, v2, and v3 evidence are not interchangeable. In particular, live-v2 Markdown update runs did not explicitly pin the leaf mode and must not be used as release evidence for body, metadata, linked-note, navigation, expression, loop, Bases, filter, currentness, or Markdown resource-lifetime workloads. They may remain useful only as historical diagnostics.

Timing does not stop merely because an API call returned. Render/update workloads wait until the expected current overlay is visible and non-pending. No-op work includes scheduler/render-frame drain. Rapid-navigation work first completes the leaf navigation transition to heavy B without waiting for B custom output, immediately navigates the same leaf to C, then verifies that final C remains current after draining. This preserves deterministic A → B → C navigation ordering while allowing obsolete B render work to overlap C; concurrent `openFile(B)` / `openFile(C)` completion order is intentionally excluded from the product currentness boundary.

Default sampling is 20 warmups plus 100 measured samples. Each result records raw samples and p50/p95/p99/min/max/mean. The comparator rejects mismatched schema version, environment, fixture identity, sampling, workload identity, semantic checksums, Markdown mode boundary, or competitor release identity.

## Workloads in live v3

- plugin initialization from a runtime-unloaded state;
- cold first render after runtime plugin/cache reset;
- warm render;
- repeated navigation;
- unchanged/no-op refresh;
- metadata-only update;
- 64 KiB body replacement;
- linked/cross-file update;
- 64-expression render;
- 32-item loop render;
- Bases cold and warm;
- filter-heavy matching (64 misses then one hit);
- real Canvas open at 1, 10, 50, and 100 file nodes;
- real Canvas active update at 1, 10, 50, and 100 nodes;
- real Canvas idle observation at 1, 10, 50, and 100 nodes;
- rapid A → heavy B → C currentness/cancellation;
- resource lifetime across repeated navigation cycles.

Markdown workloads above run in the pinned Reading/Preview boundary. Canvas workloads remain real Canvas workloads and are not converted to Markdown mode.

Settings/property-completion timing remains outside live v3 because there is not yet a stable UI timing boundary that can be applied identically to both implementations. Before release it must either gain a semantically equivalent UI measurement or be explicitly documented as non-measurable; it cannot be silently dropped from capability review.

## Metrics and release interpretation

Normal performance workloads gate on elapsed p50/p95/p99. Canvas idle deliberately does **not** gate on the fixed observation wall time; DOM mutation count is the important idle metric and renderer CPU is reported where reliable.

Heap/RSS/external/ArrayBuffer snapshots are recorded where available. Resource-lifetime memory deltas become release-gating evidence only when the renderer exposes a sufficiently controlled collection boundary; otherwise memory numbers remain observational and cannot certify the memory-release gate by themselves.

The comparator emits per-metric `win`, `tie`, or `loss`. There is no aggregate speedup claim. A run with zero important losses is evidence for that exact run only; Morphic is not release-ready until correctness/reliability, Node 22 certification, provenance, real smoke, packaging, and final convergence also pass.

## Required evidence record

Every release-candidate comparison must record:

- exact Morphic commit and built-bundle digest;
- exact frozen Custom Views identity/digests;
- benchmark schema/fixture identity;
- Obsidian/Electron/runtime/platform/architecture/CPU environment;
- pinned Markdown mode/source/enforcement identity;
- warmup and measured sample counts;
- raw samples and p50/p95/p99 summaries;
- semantic checksums/contracts;
- every important loss, if any;
- whether explicit-GC memory evidence was available.

If a real important loss appears, the release loop is: profile → identify the responsible layer → optimize without weakening semantics → add regression coverage where appropriate → rerun focused correctness/performance → periodically rerun the full qualification set.

## Commands

The harness is exposed as:

```bash
npm run bench:competitive -- --help
```

A benchmark vault must contain the freshly built Morphic bundle under plugin id `morphic`, the exact Custom Views 0.4.0 release bundle under plugin id `custom-views`, and Obsidian Bases must be available for Bases cases.

Release certification records the actual vault/environment in generated evidence rather than hard-coding a developer machine path.
