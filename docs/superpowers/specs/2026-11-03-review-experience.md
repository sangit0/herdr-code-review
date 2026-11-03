# Review experience improvements

Keep review entirely inside the existing Herdr Code Review mod, using native GPUI controls and Git. Preserve the tabbed-changes ID, saved comments, range feedback, origin comparisons and guarded Git writes. User authorized planning and implementation together.

Responsiveness: coalesce folder-watch bursts for 150ms; reuse overlapping read-only Git requests with bounded 400ms caches; invalidate after watchers/mutations; avoid rebuilding identical diffs or redrawing unchanged file polls. File views cache line contexts, widths and row sizes instead of constructing full-file context arrays per visible comment. Cache syntax tokens and bounded word diffs; no Git writes cached.

Navigation: an optional changed-file tree in All changes, filename filtering, next/previous hunk navigation with Alt+Down/Alt+Up, in-diff text search with Cmd+F and next/previous match controls. Use a retained native scroll handle. Navigation never reloads files or runs Git. Tree selection scrolls to file headers and opens collapsed files. Keep comments attached to their actual rows and preserve scroll/selection where possible.

Diff quality: word-level highlights for paired removed/added lines (bounded token diff with large-line fallback), Ignore whitespace, context levels 3/10/30, horizontal scrolling in side-by-side view. Options must affect local and origin comparisons consistently. New ref/context requests cannot install stale results. Search/word decoration never changes the saved code snapshot.

Alternatives: Rust helper is unnecessary for this pass; unbounded full-file rendering would undermine responsiveness. Adopt bounded native virtual lists and pure helpers. No dependency install, external editor requirement, automatic fetch/push, or hunk staging in this pass. Full-file context expansion is controlled by Git's unified context setting rather than a new per-hunk buffer engine.

Validation: test cache invalidation/concurrency, burst scheduling, file/machine isolation, word boundaries/Unicode/long lines, search/hunk/tree navigation, option argv, and real Git integration. Record command/build counts rather than claiming an unmeasured speedup. Run all existing tests, syntax/whitespace checks, native checks for each view and live GUI checks if the Mac is unlocked. Install only after checks pass; keep commits local unless asked to publish.
