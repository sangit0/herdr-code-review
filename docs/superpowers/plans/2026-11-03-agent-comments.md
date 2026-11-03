# Agent comments implementation plan

Goal: extend the installed Tabbed Changes mod, retaining its panel, file and diff roles.

Design (revised to the user's explicit clarification): click a code row or its gutter + to expand a retained inline comment thread immediately under that line, with no separate panel or dialog. Save text with repository, machine, path, side, line and code snapshot in Herdr shared state. Within each line thread, save/delete a comment, choose an agent in the same space, and explicitly send that individual note with its line. Sending uses hc send --if idle; never force or interrupt an agent. Failed sends retain notes. Remove a note after successful delivery; retain it after any failed delivery. No automatic delivery or connection to Codex desktop.

Approaches considered: immediate send (loses review opportunity); per-line/range saved comments plus explicit individual send (user requested inline controls); external tracker (unnecessary service).

- [x] Add pure context, repository scoping, message formatting and guarded delivery functions with failing tests first. Cover deleted rows, split sides, stale targets, blank comments and failed sends.
- [x] Add the retained inline comment view, save/delete controls and agent picker. Use existing native Textarea and shared state. Record send errors and successful history.
- [x] Wire row selection, gutter + markers and inline thread controls into diff and file tabs. Split view uses an explicit Old/New side switch. Existing double-click Neovim behavior stays.
- [x] Run npm tests and syntax checks, check the panel and live file/diff views in Herdr, install updated files, inspect a live screenshot and runtime errors. Do not send to any real agent during verification.
- [x] Update README and recipe with the workflow and limits. Keep work local until verified.

Verification: npm test and syntax checks pass. Native panel check passes. Live file and diff inline editors render; file save/reopen and no-agent rejection verified. No real agent send performed because the current space has no agents. Independent review caught stale selection/draft loss; exact-context remapping and per-context draft retention address these.

## Follow-up requirements and verification
- [x] Compact UI: 132px empty / 208px with saved notes, maximum width 600px.
- [x] Click then Shift-click selects up to 500 consecutive lines in one file/side. Range snapshots include both endpoints and all selected code.
- [x] Gutter dot/count covers all annotated lines. Amber and an Outdated warning indicate that the saved snapshot no longer matches current displayed code.
- [x] Successful send removes only that note; failures and concurrent new notes are preserved.
- [x] ⌘⇧I opens/focuses the current selection through local view focus/key handling.
- [x] Regression fixes: clear selections across preview source changes; reserve range editor height from the same selection context used by the child.
- [x] Live disposable-file check: lines 2–4 selected, shortcut focused input, saved note produced badges on all three lines, editing line 3 produced amber badges and an outdated warning. Test comment removed. Tests cover guarded success/failure cleanup; no real Herdr agent was messaged.
