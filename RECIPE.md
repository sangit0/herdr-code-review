# Herdr Code Review

A Source Control and code-review mod: tabbed diffs, whole-change multibuffer, file views, Neovim, and compact inline feedback on lines or ranges that can be sent to Herdr agents. ![Tabbed Changes](preview.png)

## What you see
- **Panel** (dock where Herdr's `changes` block sits): 42px header (branch icon, branch, ↑/↓ counts, layers "all changes", refresh), commit box (textarea + `Commit N staged` button), then sections MERGE CHANGES / STAGED CHANGES / CHANGES with 26px rows: name, folder in `dim`, `+N −N`, status letter (`blocked` M, `ansi2` A/U, `ansi1` D/!).
- **Diff tab**: 38px header (icon, name, folder, `+N −N`, inline/side-by-side pair, All changes / Single file, Open file, Neovim), 22px caption (what is compared, repo path), then 20px rows with two 40px number gutters.

## How it behaves
- Row click: preview diff tab (made once per space, renamed and reused; `shared("tabbed-changes.view")[space] = {view, tab, at}`). Double-click: pinned tab (`props.pinned`).
- Hover row: Neovim, Open file, Discard (asks), Stage/Unstage.
- Diff: double-click a line opens `nvim +LINE file` in a new tab (`tab.new {argv, folder}`); file header rows fold; double-click header goes to single-file.
- Staging moves the file between sections; the preview follows it.

## Built from
`main.js` picks `props.role`: none = panel, `diff`, `file`. `git.js` (pure: status, numstat, diff rows, side-by-side pairing, patch splitting, editor argv), `tabs.js` (tab opening, editor lookup), `panel.js`, `diff.js` (virtual list, clicks via `on_item_click` + click count from `on_mouse_down`), `viewer.js` (virtualized read-only file rows and Git gutter markers), `ui.js`, `icons/` (Lucide-style SVGs). Herdr API: `exec`, `watchFolder`, `readTextFile`, `shared/setShared`, `run("tab.new"|"tab.rename"|"tab.select")`.

## Watch out
- `run` returns nothing: find the new tab by diffing the space's tab ids.
- Virtual-list rows cannot hold handlers.
- Reads use `--no-optional-locks -c core.fsmonitor=false` so the folder watch doesn't loop.
- A diff tab is a mod pane with no folder: the panel must keep its repo while it is focused.

## Done when
`herdr-app check` passes; `npm test` passes; clicking a file opens a tab named after it, a second click reuses it, double-click opens another; All changes lists modified and untracked files; Neovim opens at the clicked line.

## Review comments
Click a code line or its gutter + (Shift-click a second line for a range; ⌘⇧I opens/focuses the input) to expand a compact inline comment thread (132px empty; 208px with saved notes) directly below that row. No separate comments panel or dialog. The retained `InlineComments` View in `comments.js` is created with `cx.new` outside render and mounted inside the selected virtual-list row. It has a textarea, Add comment, same-space agent picker, and per-note Send to agent/Delete. Closed threads use a gutter dot and count on each covered line; amber flags outdated snapshots. `comment-model.js` builds per-line contexts, scopes notes, remaps unchanged diff rows after refresh and formats delivery. File rows use the new side; deleted diff rows use the old side. Split views resolve the clicked half, with explicit Old/New controls as fallback. Hunk headers and missing cells cannot be commented on. Shared key `tabbed-changes.comments.v1` persists repository/machine-scoped notes with path, side, line and snapshot. Drafts survive switching lines in a tab. Send calls `hc(["send", "--if", "idle", address, text])`, never force; successful sends delete the note and failures retain it. No automatic sending. Verify inline save/reopen/delete in both views, and no-agent rejection. A real idle-agent send still needs end-to-end verification.

Ranges use `rangeContext` to enforce one repository, machine, path and side, consecutive visible line numbers, and at most 500 lines. `isOutdated` compares saved code with current line contexts. `sendAndRemove` deletes only after successful guarded delivery. File views reload every three seconds and refresh the inline thread references. Keyboard handling uses a tracked focus handle and `on_key_down` in the file/diff root, without replacing global key bindings.

## Remote branch comparison
The panel resolves one origin default base and places a single labeled comparison control beside branch checkout. It opens All changes with the detected explicit ref. Diff tabs show only the active comparison, Local changes and Fetch origin; no separate main/master choices. `comparison.js` resolves explicit `refs/remotes/origin/main` or `master` to immutable commit SHAs, using origin/HEAD when it points to either, then main/master fallback. Compare directly with `git diff <sha> --`, including committed changes and local edits; merge-base comparison was explicitly declined. Add untracked previews as in local All changes. Remote mode also works when drilling into one file. Fetch is explicit `git fetch --no-tags origin`; no checkout, merge or push. Missing refs show an explanation. New preview requests reset toolbar overrides. Old-side comment contexts include the base ref name and captured SHA; pending comments stay visible as outdated after fetching the same branch, but main/master comments do not mix. Draft identity includes the SHA.

## Branch switching and Git controls
The Source Control header stays compact, with compare/all-changes/refresh icons. A separate branch row shows a clickable branch name/chevron and ↓behind ↑ahead counts. Below it are Fetch origin (cloud), Pull (down), and a labeled Push to upstream / Publish branch action (up/cloud-upload). Commit has a check mark. Push targets only the current local ref and configured upstream; publishing sets origin/upstream for the same branch name. Branch and upstream are rechecked for Push/Pull; Pull is fast-forward-only and disables automatic stash/rebase. No force actions.

Clicking the branch name opens the same mod with role `branches`, a 520×420 dialog. `branch-picker.js` provides native Input filtering and a virtual list with local/remote/current/worktree labels. `branches.js` lists full refs, skips symbolic remote HEAD, guards stale current branch+commit, switches local branches normally, or creates a local tracking branch for a remote ref. Existing local branches with different upstreams are not silently repointed. Switch success emits a shared branch-change event so the panel refreshes immediately. Git retains compatible local edits and rejects overwrites. Branch names are argv entries, never interpolated shell commands. Test with disposable local and bare repositories; do not switch or push the user's repository merely to validate the feature.

## Responsive review navigation and diff options
`read-cache.js` provides bounded read deduplication, TTL reuse, coalescing and pure memo caches; `repository.js` wraps read-only Git with root/machine/argument keys and emits invalidation events after writes. Watch callbacks coalesce for 150ms; file fallback polling is 10 seconds. Diff reloads fingerprint loaded data and skip unchanged rebuilds. Clearing a view invalidates its fingerprint so rapid Context 3→10→3 cannot leave it empty. Scope identity excludes presentation options so surviving comment selections remap safely. File contexts/width/sizes are cached, and unchanged metadata does not call the retained comment child.

`review-model.js` owns bounded token LCS word spans, syntax-span splitting, Git context/whitespace flags, hunk/search targets, tree flattening and horizontal comment placement. `review-controls.js` renders a 30px options toolbar, optional 34px search row, and optional 180px changed-file tree. Inputs and `VirtualListScrollHandle` are created in `init`. Navigation uses the scroll handle and does no Git I/O. Folder/file handlers are attached to the virtual list, never inside row callbacks. Search expands folded files; Alt+Up/Down moves hunks, Cmd+F opens search, Enter/Shift+Enter moves matches.

Words defaults on. Context cycles 3/10/30. Ignore spaces passes `--ignore-all-space` to local and origin diff paths. Because Git -w emits new-side whitespace in context rows, mark those rows `oldContextUnavailable` and disallow original-side context comments rather than inventing a snapshot; actual removals and current-side comments remain valid. Side-by-side horizontal scrolling uses content-local pointer positions for side detection; comment placement derives visible offset from content/viewport event bounds. Cmd+Shift+I reveals the input by resetting horizontal position. Long token comparisons have a bounded whole-line fallback, preserving the underlying source text.

Run `npm test`, `npm run check:herdr` (panel, inline/split diff, expanded comments/file view, branch picker), and optionally `npm run benchmark`. Tests use real disposable Git repositories plus native host-only stubs. They cover option round-trip races, scope changes, unchanged refreshes, selection preservation, ignored-whitespace comment fidelity, invalidation during flight and bounded caches. Native checks do not replace a visual/physical-pointer review; user selected automated verification for this pass.

The default comparison control uses origin/HEAD when it names main or master, then main/master fallback. Hide it if neither ref is available; Fetch origin remains accessible. Do not use the current feature branch upstream as the review base.
