# Herdr Code Review

Formerly **Tabbed Changes**. The internal mod ID remains `tabbed-changes` for existing installations.

**Review code, leave inline feedback, and send it straight to your coding agent in [Herdr](https://herdr.dev).**

A VS Code-style Source Control mod with branch switching, explicit upstream push/pull controls, comparisons against `origin/main` or `origin/master`, tabbed diffs, and compact review comments on lines or ranges. Review a change, select the code, and send the original snippet with your instructions to an agent running in Herdr.

![Source Control and tabbed diffs](preview.png)

## Review with your agent

1. Open a changed file or a file tab.
2. Click a code line or the **+** beside its number. For a range, click the first line, then **Shift-click** the last.
3. Press **⌘⇧I** to open or focus the comment box beneath your selection.
4. Write your feedback and click **Add comment**.
5. Choose an idle agent in the same Herdr space, then click **Send to agent** on the saved comment.

The message includes the repository, file path, line range, old/new side, code snapshot, and your feedback. Sending submits it immediately. A successful send removes the comment; a failed send keeps it for retry. The mod never interrupts agents or forces past their prompts.

### Comments stay with the code

- **Inline threads:** compact boxes beneath the selected code, in file views and inline or side-by-side diffs.
- **Line ranges:** up to 500 consecutive lines in the same file and side. Ranges cannot cross hidden diff gaps.
- **Gutter badges:** a dot and count identify lines with saved comments.
- **Changed-code warnings:** amber badges and an **Outdated** label flag snapshots that no longer match the displayed code.
- **Local persistence:** saved notes are scoped to repository and machine in Herdr shared state. Drafts survive switching lines within an open tab.
- **Original context:** saved comments retain their original code and line numbers; they are not automatically relocated when code moves.

File views check for changes every three seconds. Diff views use their existing folder watch and refresh cycle. Agent delivery targets agents running **inside Herdr**, not an external Codex desktop chat.

## Branch switching and Git actions

Click the **branch name and chevron** in Source Control to open a searchable branch picker. Local branches switch in place; remote branches create a local tracking branch when one does not exist. The picker identifies the current branch and branches checked out in other worktrees. If a local branch with the same name tracks a different remote branch, select that local branch explicitly rather than silently changing its upstream.

Switching uses normal `git switch`: compatible uncommitted changes can carry over, and Git refuses a switch that would overwrite them. The mod does not force checkout, discard changes, or auto-stash.

The compact Git action row provides:

- **Fetch origin** (cloud): update remote refs without merging.
- **Pull** (down arrow): fast-forward only from the displayed upstream, without automatic stashing.
- **Push to …** (up arrow): push only the checked-out branch to its configured upstream. The destination is visible in the label and tooltip.
- **Publish branch** (cloud upload): push the current branch to `origin` under the same name and set its upstream.

Ahead/behind counts appear beside the branch name. Push and Pull recheck the current branch and upstream before acting; if either changed, refresh first. Push uses an explicit branch refspec and does not push unrelated branches or tags. Origin comparisons do not change the push destination. There is no force-push action.

## Compare with origin/main or origin/master

Use the **Compare origin** comparison icon in the Source Control panel to review all differences from the remote default branch. The mod uses `origin/HEAD` when it points to `main` or `master`, otherwise prefers `origin/main` and falls back to `origin/master`.

In a diff tab, use **Local**, **origin/main**, or **origin/master** in the comparison bar. Remote comparison includes committed changes, staged and unstaged edits, deletions, and untracked-file previews. It compares the remote branch's last fetched commit directly with the current working tree; it does not use the branch's merge base. Double-click an All changes file header to drill into that file. Existing comments, line ranges and inline/side-by-side views remain available.

**Fetch origin** explicitly runs `git fetch --no-tags origin` to update remote-tracking refs. Viewing a comparison does not fetch automatically, merge, switch branches, or push. If the requested remote branch has not been fetched or does not exist, the view shows an explanation. Old-side comments retain their branch and commit snapshot so feedback from different comparison bases stays separate.

## Source Control features

| Feature | Behavior |
|---|---|
| Source Control panel | Merge, Staged, and Changes sections; file icons; added/deleted counts; stage, unstage, confirmed discard, commit, push, pull, and publish branch. |
| Branch switching | Search local and remote branches; create tracking branches; protect conflicting local edits. |
| Upstream Git actions | Fetch, fast-forward Pull, current-branch Push, Publish branch, and ahead/behind counts. |
| Remote comparison | Compare all committed and local changes directly against the last fetched `origin/main` or `origin/master`. |
| Inline feedback | Comment on lines/ranges, show gutter badges and outdated warnings, and send context to a Herdr agent. |
| Tabbed diffs | Single-click reuses a preview tab; double-click pins a separate tab. |
| All changes | Review changed files in one scrolling view with collapsible file headers. |
| Inline and side-by-side diffs | Old/new line numbers, added/deleted highlights, and syntax coloring. |
| File views | Whole-file previews with added, modified, and deleted-line gutter markers. |
| Neovim integration | Open a file at a selected line, using your own editor configuration, LSP, plugins, and keymaps. |
| File-type icons | Material Icon Theme icons in the panel and tab headers. |

![Diff tab](docs/screenshots/diff.png)
![All changes](docs/screenshots/all-changes.png)
![Side-by-side diff](docs/screenshots/side-by-side.png)
![File view with Git gutter markers](docs/screenshots/file-gutter.png)
![Neovim opened at the changed line](docs/screenshots/neovim.png)

These screenshots show the Source Control views; the current mod also includes inline review comments.

## Install

Requires Git 2.x with `git switch` support and a compatible Herdr app. Developed and checked on macOS with Herdr 0.1.12. Neovim is optional; it is only needed for the editor action.

From this repository:

```sh
mkdir -p ~/.config/herdr-app/mods
cp -R mods/tabbed-changes ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/tabbed-changes
```

Herdr's shipped layouts are read-only. Clone your layout:

```sh
herdr-app do layout.clone '{"name":"main","as":"tabbed-changes"}'
```

In `~/.config/herdr-app/layouts/tabbed-changes.json`, change the existing Changes block's `"mod": "changes"` to `"mod": "tabbed-changes"`. Keep the rest of the layout intact.

The internal mod ID, folder, layout references, asset paths, and saved-state keys remain `tabbed-changes` for compatibility with existing installations.

### Use another terminal editor

The default is `nvim`. Set Herdr's shared key `tabbed-changes.editor` to an executable such as `vim`, `hx`, or an absolute executable path. The terminal editor brings its own language-server support; this mod does not provide an LSP client.

## Development and validation

```sh
npm test
herdr-app check mods/tabbed-changes
```

No npm dependencies are required. Tests cover Git parsing, syntax coloring, icons, line/range context, comment scoping, stale snapshots, guarded delivery, and successful-send cleanup. Also exercise the UI in Herdr: the native check does not cover every deferred row or interaction. See [RECIPE.md](RECIPE.md) for a source-based build brief and [docs/PUBLISHING.md](docs/PUBLISHING.md) for publishing.

The comment UI, ranges, keyboard shortcut, badges, and changed-code warnings have been checked in a running Herdr app. A real idle-agent delivery still needs end-to-end verification; send success/failure and cleanup rules are covered by tests.

## Limits

- Whole-file staging; no hunk or selected-line staging.
- Up to 1,000 files in the panel, 8,000 diff rows, and 40 untracked-file previews in All changes.
- File previews are capped at 400,000 characters and 20,000 lines.
- Side-by-side diffs have no horizontal scrolling.
- Syntax coloring is line-based, so multiline comments and strings are approximate.
- At most 10,000 characters per comment and 60,000 characters per delivery message.
- Saved comments can become outdated; the recipient must verify the snapshot against the current code.

## Credits and license

MIT: see [LICENSE](LICENSE). File icons are from [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme), under its included [MIT license](mods/tabbed-changes/icons/files/LICENSE.txt). Other icons are Lucide-style SVGs (ISC). Inspired by [herdr-git-changes](https://github.com/aBER0724/herdr-git-changes) and Zed's Git panel; no code copied.
