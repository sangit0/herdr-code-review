# Origin comparison

User selected direct comparison against origin/main or origin/master, including committed changes and local edits, rather than merge-base comparison.

- [x] Test resolver and direct diff behavior with real disposable Git repositories: main/master fallback, origin/HEAD, missing refs, ambiguous local branch names, committed-only changes, staged/unstaged edits, deleted and untracked files.
- [x] Add pure comparison helpers resolving full remote refs to immutable SHAs.
- [x] Add panel entry and per-diff Local/main/master controls, explicit Fetch origin, caption and missing-reference errors.
- [x] Preserve untracked single-file previews; scope old-side comments to their baseline and preserve old snapshots across fetches.
- [x] Reset overrides on new preview requests; cover the production diff loader with host-only stubs and real Git.
- [x] Update README and recipe. Tests, syntax checks and native check pass; updated mod installed.
- [ ] Live visual check: Mac was locked when computer-use verification was attempted. User was asked to unlock; no locked-screen workaround used. No fetch or real agent send performed during verification.
