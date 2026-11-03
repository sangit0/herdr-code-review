# Review Experience Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve responsiveness, navigation and diff readability inside the same Herdr mod.
**Architecture:** Pure read-cache/scheduling and diff/navigation helpers feed the existing native views. Keep virtualized rows, retained input/scroll handles, and explicit Git writes. Work in the existing checkout on feature/review-experience; no new worktree was requested.
**Tech Stack:** JavaScript, Herdr/GPUI native API, Git CLI, Node assertion tests. No added dependencies.
**Spec:** ../specs/2026-11-03-review-experience.md

## Global Constraints
- Preserve tabbed-changes IDs/state and existing review/Git safeguards.
- Native inputs/scroll handles are created outside render; deferred rows contain no event handlers.
- Read caches are bounded, keyed by root/machine/arguments and invalidated after repository events; never cache writes.
- No automatic fetch/push or external editor requirement.

## Review Focus
- Stale async results after source/options changes: test generation invalidation and production loader guards.
- Concurrent reads and watcher bursts: assert actual task/command counts.
- Comment range identity through navigation/context changes: preserve exact source/path/side and snapshots.
- Huge/Unicode lines: bound word-diff work and preserve the complete source text.
- Empty/binary/collapsed files and no search results: navigation remains finite and never jumps to wrong rows.

### Task 1: Responsiveness
Files: create read-cache.js and tests/read-cache.test.mjs; modify panel.js, diff.js, viewer.js; update mutation events in branch-picker.js as needed.
Interfaces: ReadCache.read(key, loader), invalidate(); Coalescer.request(schedule, work), cancel(). A lazy read-cache wrapper in repository.js keys native Git reads by source/argv. View watchers debounce 150ms and mark their read caches invalid; writes trigger shared repository change events.
- [x] Write tests for overlapping reads, TTL, bounds, failure retry, invalidation during flight and source separation; observe failure.
- [x] Implement pure cache and coalescer; pass tests.
- [x] Wire read-only Git paths and watcher scheduling. Skip identical diff rebuilds; precompute file contexts/width/sizes. Test production loader unchanged-data behavior.
- [x] Run suite; record measured request/build counts and commit.

### Task 2: Diff and navigation helpers
Files: create review-model.js and tests/review-model.test.mjs; modify comparison.js and ui.js.
Interfaces: diffFlags(options); wordChanges(old,new); changedTargets(rows); searchRows(rows,query); stepTarget(indices,current,direction); fileTree(files,query,collapsed); splitTokens(tokens,spans).
- [x] Write literal-fixture tests for options, paired word changes, Unicode/large-line fallback, cyclic navigation, search and folder filtering; observe failure.
- [x] Implement bounded helpers, syntax-token caching and highlight rendering.
- [x] Verify all local/origin diff commands receive the same whitespace/context flags with real Git tests; commit.

### Task 3: Native review controls
Files: modify diff.js; add focused review-controls.js if needed; update host stubs/tests and README/RECIPE.
- [x] Add retained scroll/input state and cached tree/search/hunk indexes. Wire next/previous hunk, search/matches, file-tree navigation, word/whitespace/context options and split scrolling.
- [x] Keep pointer side detection relative to scrolled content; keep range comments and pending drafts correct.
- [x] Add integration checks around option/source changes, unchanged reloads and navigation state. Run full suite, native view checks, independent code review, and GUI check if available.
- [x] Install updated same mod, update docs and commit. Do not push.

## Execution ledger
Baseline: npm test passed; clean checkout. Branch feature/review-experience created. Native VirtualListScrollHandle and Timer.after exist in installed declarations. No memory entries found for this project.

Task 1 complete: 25 watch events schedule one refresh; two overlapping reads load once; identical production diff reload builds once and does not notify again. File metadata polling also avoids rebuilding an unchanged comment child.
Tasks 2/3 complete: helpers/options and native controls integrated together because row contexts, word spans and navigation share the same build. Full suite/native checks pass.
Review findings fixed: option round-trip stamp invalidation; scope-preserving selection restore; honest old-context guard for ignored whitespace; visible horizontal comment placement; unchanged child-update suppression. New regressions exercise local, staged and origin comparisons.
Ruling: Git -w cannot provide exact old whitespace without additional per-file reads. Disallow original-side context comments in that presentation mode, keep removals/current-side comments, and clearly offer showing whitespace for exact context.
User chose automated verification instead of unlocking the Mac. Native materialization covers all roles; live visual/pointer behavior is unverified.
Synthetic helper benchmark: 20,000 lines / 50 notes / 4 passes, efdc50b baseline 206.83ms versus indexed helper 3.18ms on one run. No application-wide speedup claim.
