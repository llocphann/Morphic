# Morphic documentation

This directory contains only current architecture, certification, provenance, and release material. Bot-era integration notes and obsolete benchmark evidence are intentionally excluded from the release tree.

## Current documents

- [`CORE_V2.md`](CORE_V2.md) — production Core V2 architecture, invariants, correctness contract, and release boundary.
- [`performance/competitive-custom-views-0.4.0.md`](performance/competitive-custom-views-0.4.0.md) — direct live Obsidian benchmark protocol against the frozen Custom Views 0.4.0 baseline.
- [`provenance/CUSTOM_VIEWS_0.4.0_AUDIT.md`](provenance/CUSTOM_VIEWS_0.4.0_AUDIT.md) — source-provenance review and attribution-removal gate.
- [`release/FINAL_RELEASE_CHECKLIST.md`](release/FINAL_RELEASE_CHECKLIST.md) — authoritative checklist for correctness, performance, smoke, packaging, transfer, and publication.

## Evidence policy

Generated benchmark/provenance evidence should identify the exact Morphic commit, environment, and frozen competitor/source baseline. Local generated evidence is not committed automatically. Only reviewed evidence that is useful to the public release should be promoted into the final repository.

Historical development branches, bot handoff notes, and old Core-V2-vs-legacy evidence are not release certification for Morphic vs Custom Views 0.4.0 and should not be reintroduced as release proof.
