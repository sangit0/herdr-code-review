# Tabbed Changes

A VS Code–style **Source Control** panel for [Herdr](https://herdr.dev) where every file opens in a **tab** instead of inline. Click a change to see its diff, view every change at once, open the file with git markers in the gutter, or jump straight into Neovim at the line you care about.

![Tabbed Changes](preview.png)

## Features

| | |
|---|---|
| **Source Control panel** | Merge / Staged / Changes sections, file-type icons, `+N −N` counts, stage / unstage / discard (asks first), commit box (⌘↩), push / pull / publish. |
| **Diff in a tab** | Single click reuses one *preview* tab (like VS Code); double-click opens a pinned tab of its own. |
| **All changes** (multibuffer) | Every changed file stacked in one scrolling tab, Zed-style. Click a file header to fold it, double-click to drill in. |
| **Inline or side by side** | Old/new line numbers, bold red/green lines, syntax-highlighted code. |
| **File tab with git gutter** | The whole file with green (added), blue (modified) and red (deleted-here) markers and tinted lines. A **Diff** button jumps to that file's diff. |
| **Open in Neovim** | Hover a row, or double-click any diff line, to open `nvim +LINE file` in a new tab: your own LSP, plugins and keymaps. A missing editor prints an install hint instead of failing silently. |
| **File-type icons** | 34 Material Icon Theme icons in the panel and every tab header. |

![Diff tab](docs/screenshots/diff.png)
![All changes](docs/screenshots/all-changes.png)
![Side by side](docs/screenshots/side-by-side.png)
![File tab with git gutter](docs/screenshots/file-gutter.png)
![Open in Neovim at the changed line, with LSP](docs/screenshots/neovim.png)

### Why Neovim and not built-in LSP?
Herdr's code widget has no language-server client, so rather than half-build one the mod opens your editor, where LSP already works. Use another editor by setting the shared key `tabbed-changes.editor` (e.g. `vim`, `hx`).

## Install

```sh
cp -R mods/tabbed-changes ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/tabbed-changes
```

Herdr's own layouts are read-only, so clone one and point its `changes` block at the mod:

```sh
herdr-app do layout.clone '{"name":"main","as":"tabbed-changes"}'
# then in ~/.config/herdr-app/layouts/tabbed-changes.json change  "mod": "changes"  to  "mod": "tabbed-changes"
```

Needs git 2.x and a recent Herdr (developed on 0.1.x, macOS).

## Development
`npm test` runs the pure helpers (`git.js`, `highlight.js`, `fileicons.js`) under node. `herdr-app check mods/tabbed-changes` loads the mod once. See [RECIPE.md](RECIPE.md) for how it is built.

## Limits
Whole-file staging only; 1,000 files in the panel; 8,000 diff rows and 40 untracked files in All changes; side-by-side has no sideways scroll; syntax colouring is per line, so multi-line comments and strings are approximate.

## Credits & licence
MIT (see `LICENSE`). File icons are from [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) (MIT, `mods/tabbed-changes/icons/files/LICENSE.txt`). Other icons are Lucide-style SVGs (ISC). Inspired by [herdr-git-changes](https://github.com/aBER0724/herdr-git-changes) and Zed's git panel; no code copied.

## Review comments for agents

Click a code line or the **+** beside its number. To comment on a range, click the first line, then **Shift-click** the last (up to 500 consecutive lines in the same file and side). Press **⌘⇧I** to open/focus the comment input for the selected line or range. The compact box stays directly beneath the selection.

Write your note and **Add comment**. Choose an idle Herdr agent in the same space, then **Send to agent**. The message includes the repository, file path, line range, old/new side, original code snapshot and your comment; it submits immediately. A successful send removes the comment. Failed sends keep it for retry. No agent is interrupted or forced past a prompt.

Saved notes persist in Herdr's local shared state, scoped to repository and machine. A gutter dot and count mark the covered lines; amber means the original code no longer matches. Open the thread to see **Outdated · code changed**. Comments retain their original snapshot rather than automatically moving to other lines. File views refresh every three seconds; diff views follow their existing refresh/watch behavior. Ranges cannot cross files, sides or hidden diff gaps. Unfinished drafts survive switching lines in an open tab. This targets agents running inside Herdr, not an external Codex desktop chat.
