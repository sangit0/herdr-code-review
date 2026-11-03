# Branch switching and Source Control actions

User wants a VS Code-style branch picker and familiar Git controls in Changes. User explicitly chose pushing the checked-out branch to its upstream only, without an extra main/master push destination.

- [x] Add branches.js listing local/remote refs, skipping symbolic remote HEAD and identifying current/other-worktree branches.
- [x] Guard stale branch/commit before switching. Use git switch without force; create remote tracking branches only when the local name is available, otherwise require an existing matching upstream or explicit local choice.
- [x] Add searchable 520×420 BranchPicker role. Branch click opens it; switching signals the panel to refresh.
- [x] Separate Source Control header actions from clickable branch/count row and fetch/pull/push controls. Show destination in push label/tooltips and distinguish Publish branch.
- [x] Push uses explicit current local branch ref to its configured upstream, or origin/same-name with set-upstream. No unrelated branches/tags/submodule pushes, no force.
- [x] Pull validates displayed branch/upstream and uses explicit destination with fast-forward-only/no-rebase/no-autostash. Review caught stale Pull state; guards and immediate refresh address it.
- [x] Disposable real Git tests cover local/remote switch, tracking config, dirty-file refusal, stale state, other-worktree refusal, push.default=matching, follow-tags prevention, explicit upstream mapping, and Pull guards. No actual workspace switch or network push performed.
- [x] Tests, syntax, whitespace and native UI checks pass for panel and branch picker, including deferred sample rows. Installed copy matches source; Herdr runtime reports no errors.
- [ ] Full visual/click check remains pending while Mac is locked. Do not bypass the lock.

Reference checked: https://code.visualstudio.com/docs/sourcecontrol/branches-worktrees (clickable current branch and branch picker). Internal mod ID stays tabbed-changes.
