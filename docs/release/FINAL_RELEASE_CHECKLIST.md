# Morphic final release checklist

Status: **PRE-RELEASE — DO NOT TAG OR PUBLISH YET**

This is the authoritative release convergence contract. A box may be checked only with evidence from the exact candidate commit or the generated artifact named by the item.

## 1. Repository convergence

- [x] `main` is the canonical development/release branch.
- [x] CI targets `main` only.
- [x] Release workflow targets version tags and creates draft releases.
- [x] Obsolete bot-era integration documentation and historical P7 evidence removed from the release tree.
- [x] Obsolete `HANDOFF.md` and inherited upstream `AGENTS.md` removed.
- [x] Dead Rusty Engine/WASM declaration artifact removed.
- [x] Morphic-specific `.editorconfig`, `.gitignore`, and `.npmrc` established.
- [x] `.codex/`, generated `main.js`, generated provenance evidence, and the currently-unreviewed local lockfile are excluded from source control.
- [x] Repository-hygiene guard added and wired into CI/release.
- [x] npm 11.6.0 runner is repository-owned and required by repository hygiene.
- [ ] Run `node scripts/pinned-npm.mjs run check:repo-hygiene` on the exact local candidate.
- [ ] Delete obsolete remote branches/tags after the final development source is verified on `main`.
- [ ] Decide whether `Morphic-test` itself needs a root-history rewrite. This is optional if only a clean certified snapshot is moved into the final `Morphic` repository.

## 2. Settings and product surface

- [x] Support control appears before Views in the implementation.
- [x] Funding target is `https://www.buymeacoffee.com/llocphann`.
- [x] Compact presets use `View 1`, `View 2`, ... naming.
- [x] Add, rename, reorder, edit, and delete operations are implemented.
- [x] Modern Settings API explicitly renders `General` after Views.
- [x] Preset tabs implement `tablist` / `tab` semantics and Left/Right/Home/End keyboard navigation.
- [x] Regression tests cover naming, structure, funding URL, and keyboard index behavior.
- [ ] Verify the complete Settings surface visually in Obsidian 1.13.x.
- [ ] Verify the legacy Settings fallback on the oldest version that remains supported if `minAppVersion < 1.13.0` is retained.

## 3. Automated correctness certification — exact candidate commit

Run in a clean workspace under **Node 22 + npm 11.6.0**. Use `scripts/pinned-npm.mjs`; do not substitute the npm version bundled with a Node point release.

- [ ] `node --check scripts/pinned-npm.mjs`;
- [ ] `node scripts/pinned-npm.mjs --version` reports npm 11.6.0;
- [ ] dependency installation succeeds through `node scripts/pinned-npm.mjs install --ignore-scripts --no-package-lock`;
- [ ] `node --check scripts/competitive-benchmark.mjs`;
- [ ] `node --check scripts/provenance-audit.mjs`;
- [ ] `node --check scripts/check-release-metadata.mjs`;
- [ ] `node --check scripts/repository-hygiene.mjs`;
- [ ] `node --check version-bump.mjs`;
- [ ] `node scripts/pinned-npm.mjs run check:repo-hygiene`;
- [ ] `node scripts/pinned-npm.mjs run check:release-metadata`;
- [ ] `node scripts/pinned-npm.mjs run build`;
- [ ] full `node scripts/pinned-npm.mjs test`;
- [ ] `node scripts/pinned-npm.mjs run lint` with zero errors;
- [ ] `git diff --check`;
- [ ] tracked tree remains clean after certification.

Record the exact commit SHA, Node version, npm version, test count, and warnings.

## 4. Reliability / lifecycle gates

Automated tests plus live smoke must establish:

- [ ] stale async work never commits after losing currentness;
- [ ] rapid A → heavy B → C navigation ends on C with no stale B commit;
- [ ] unsaved Live Preview content stays fresh;
- [ ] linked-note updates invalidate the correct owners;
- [ ] metadata-only updates do not force unnecessary body work;
- [ ] cross-file dependency changes remain fresh;
- [ ] repeated navigation releases render resources;
- [ ] Canvas node/view cleanup is complete;
- [ ] disable/re-enable does not retain listeners/owners/resources;
- [ ] failed/stale navigation preserves valid last-known-good/native surfaces.

## 5. Direct competitive performance vs Custom Views 0.4.0

Frozen baseline:

- source commit `1d9f2e99c3bfcc82dd9d657ead65fffadbdac0f5`;
- release `main.js` SHA-256 `7055eb74f42a2525e816945a212f89089909da4ef5aa6da1d5e41f67e8a8e998`;
- release `manifest.json` SHA-256 `1f009e66b60ce708f5fcbf5f847626b17457b5b0da51f372442341d7eb774368`;
- release `styles.css` SHA-256 `2ac648e2c4dc6dbe216b6119bdf5c345e2222c4b257401ae6c2ae8d871a1cc1a`.

Protocol:

- [ ] same Obsidian/Electron environment;
- [ ] same fixture/data/semantics/cache boundaries;
- [ ] exact Morphic candidate bundle verified against candidate source build;
- [ ] 20 warmups + 100 samples unless a documented workload-specific exception exists;
- [ ] p50/p95/p99 reported for latency metrics;
- [ ] startup/init measured;
- [ ] first and warm render measured;
- [ ] repeated navigation measured;
- [ ] no-op refresh measured;
- [ ] metadata/body/linked/cross-file updates measured;
- [ ] expression-heavy and loop-heavy paths measured;
- [ ] Bases cold/warm measured;
- [ ] filter-heavy path measured;
- [ ] Canvas 1/10/50/100 idle and active measured;
- [ ] rapid-currentness path measured;
- [ ] CPU evidence recorded where reliable;
- [ ] memory/resource evidence recorded where reliable;
- [ ] **no important competitive loss remains**.

Do not replace this gate with an aggregate speedup number.

## 6. Source provenance / attribution gate

Audit policy is in `docs/provenance/CUSTOM_VIEWS_0.4.0_AUDIT.md`.

- [x] frozen upstream source/release identity recorded;
- [x] reproducible similarity-triage harness added (`audit:provenance`);
- [x] Core V2/compiler/new Morphic-specific areas identified;
- [x] shared product-layer areas remain `DERIVED/UNCERTAIN` rather than being assumed clean from changed hashes;
- [x] inherited repo scaffolding/dead artifacts pruned where no longer needed;
- [ ] run `node scripts/pinned-npm.mjs run audit:provenance -- --strict` against the exact candidate commit;
- [ ] manually review every `EXACT`, `REVIEW_HIGH`, and material `REVIEW_MEDIUM` result;
- [ ] rewrite material upstream expression that should not ship in the final independent implementation, or deliberately retain attribution for it;
- [ ] re-run audit after rewrites;
- [ ] decide final `LICENSE-MIT-ORIGINAL` / `NOTICE` state from the **release tree**, not from branch history.

Until this section closes, do not remove upstream MIT attribution.

## 7. Dependency reproducibility decision

Current pre-release policy intentionally ignores `package-lock.json` to avoid carrying stale machine-generated state from earlier Node/npm versions into the repository. Runtime/tooling policy is explicitly pinned to Node 22 and npm 11.6.0. npm 10.9.8 is not a certification target because its Arborist peer-set resolver can crash before normal dependency conflict reporting.

Before the final release candidate:

- [ ] perform a clean Node 22/npm 11.6.0 dependency resolution;
- [ ] review resolved dependency versions and security/deprecation warnings;
- [ ] explicitly decide whether the final repository will commit a reviewed `package-lock.json`;
- [ ] if a lockfile is adopted, remove it from `.gitignore`, commit the clean Node 22/npm 11.6.0 lockfile, and change CI/release installation to the pinned equivalent of `npm ci --ignore-scripts`;
- [ ] if no lockfile is adopted, document why non-locked dependency resolution is acceptable for release reproducibility.

A stale lockfile from a previous local environment must never be committed merely to satisfy this checklist.

## 8. Obsidian compatibility and real smoke

Current manifest uses `minAppVersion: 1.11.10`, while Morphic also supports the declarative Settings API introduced in Obsidian 1.13 through a dual-path implementation. The compatibility floor must be demonstrated, not assumed.

Using the exact built candidate bundle:

- [ ] test the oldest supported Obsidian version if `1.11.10` remains the floor;
- [ ] test a current Obsidian 1.13.x desktop build;
- [ ] plugin loads cleanly;
- [ ] plugin unloads cleanly;
- [ ] Settings opens and all controls work;
- [ ] View preset add/rename/reorder/edit/delete works;
- [ ] native filter editor behaves correctly;
- [ ] Reading view render works;
- [ ] Live Preview render works;
- [ ] editable content remains fresh while unsaved;
- [ ] linked-note update refreshes correctly;
- [ ] Canvas render/update/cleanup works;
- [ ] Bases cold/warm paths work;
- [ ] HTML/CSS/JavaScript completion works;
- [ ] JavaScript disable/enable behavior is correct;
- [ ] rapid navigation stays current;
- [ ] disable/re-enable works;
- [ ] vault/app reopen works;
- [ ] no unexpected Developer Console errors remain;
- [ ] `isDesktopOnly: false` is retained only if supported non-desktop behavior is actually qualified or intentionally documented.

## 9. Versioning and packaging

- [x] package/manifest plugin identity is `morphic` / Morphic.
- [x] manifest `fundingUrl` uses the supported Obsidian manifest field.
- [x] version-bump script rejects a missing target version and updates manifest/version mapping deterministically.
- [x] release metadata checker validates package/manifest/versions alignment.
- [x] release metadata checker enforces Node 22, npm 11.6.0, and `packageManager: npm@11.6.0`.
- [x] release metadata checker can validate a plain or `v`-prefixed tag.
- [x] release workflow uses Node 22 and repository-pinned npm 11.6.0.
- [x] release workflow builds, tests, lints, diff-checks, and runs repository/metadata guards before artifact creation.
- [x] release workflow creates SHA-256 checksums.
- [x] release workflow attests artifact provenance.
- [x] release workflow creates a draft release.
- [ ] select final public version;
- [ ] update `package.json`, `manifest.json`, and `versions.json` through the reviewed versioning path;
- [ ] move relevant `CHANGELOG.md` content from Unreleased to the final version heading;
- [ ] review `minAppVersion` against the actually tested compatibility floor;
- [ ] final README/license/notice review;
- [ ] final security/dependency review.

Official Obsidian distribution expects `manifest.json`, `main.js`, and optional `styles.css` from a GitHub release whose tag matches the manifest version; the release workflow is built around that contract.

## 10. Final repository transfer and publication

When all prior gates are closed:

- [ ] create the final clean snapshot for `llocphann/Morphic`;
- [ ] ensure only intended source/release files are transferred;
- [ ] use `main` as the canonical branch in the final repository;
- [ ] do not transfer obsolete bot/evidence branches;
- [ ] re-run repository hygiene, metadata, and correctness certification on the final repository commit;
- [ ] tag the certified `main` commit;
- [ ] let the release workflow create the draft artifact;
- [ ] download the generated release artifact and smoke-test **that artifact**;
- [ ] compare artifact hashes with `SHA256SUMS.txt`;
- [ ] publish the draft only after artifact verification passes.

## Release rule

Morphic is release-ready only when every applicable checkbox above is backed by evidence. Repository cleanup, a green build, a successful benchmark microcase, or a manually working plugin alone is not sufficient.
