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
The panel's Compare origin branch icon opens All changes with `view.comparison: "origin"`. Diff tabs add a 30px comparison bar: Local, origin/main, origin/master, Fetch origin. `comparison.js` resolves explicit `refs/remotes/origin/main` or `master` to immutable commit SHAs, using origin/HEAD when it points to either, then main/master fallback. Compare directly with `git diff <sha> --`, including committed changes and local edits; merge-base comparison was explicitly declined. Add untracked previews as in local All changes. Remote mode also works when drilling into one file. Fetch is explicit `git fetch --no-tags origin`; no checkout, merge or push. Missing refs show an explanation. New preview requests reset toolbar overrides. Old-side comment contexts include the base ref name and captured SHA; pending comments stay visible as outdated after fetching the same branch, but main/master comments do not mix. Draft identity includes the SHA.

## Branch switching and Git controls
The Source Control header stays compact, with compare/all-changes/refresh icons. A separate branch row shows a clickable branch name/chevron and ↓behind ↑ahead counts. Below it are Fetch origin (cloud), Pull (down), and a labeled Push to upstream / Publish branch action (up/cloud-upload). Commit has a check mark. Push targets only the current local ref and configured upstream; publishing sets origin/upstream for the same branch name. Branch and upstream are rechecked for Push/Pull; Pull is fast-forward-only and disables automatic stash/rebase. No force actions.

Clicking the branch name opens the same mod with role `branches`, a 520×420 dialog. `branch-picker.js` provides native Input filtering and a virtual list with local/remote/current/worktree labels. `branches.js` lists full refs, skips symbolic remote HEAD, guards stale current branch+commit, switches local branches normally, or creates a local tracking branch for a remote ref. Existing local branches with different upstreams are not silently repointed. Switch success emits a shared branch-change event so the panel refreshes immediately. Git retains compatible local edits and rejects overwrites. Branch names are argv entries, never interpolated shell commands. Test with disposable local and bare repositories; do not switch or push the user's repository merely to validate the feature.
