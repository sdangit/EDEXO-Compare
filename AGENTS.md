# Repository workflow

## Branches and remotes

- `main` mirrors the original repository's `main`. Never put development commits
  on it; update it by fast-forward only.
- `macos` is our integration baseline and will be the fork's default branch.
- Create work branches from `macos`: `fix/<topic>`, `feature/<topic>`,
  `chore/<topic>`, or `docs/<topic>`. Commit work on these branches.
- `origin` points to our fork: `https://github.com/sdangit/EDEXO-Compare.git`.
- `upstream` points to the original: `https://github.com/bahuckel/EDEXO-Compare.git`.
  Push our branches to `origin`, never to `upstream`. Check `git remote -v` before
  synchronization or push. Local `main` tracks `upstream/main`; `macos` tracks
  `origin/macos`. Keep the fork's `main` synchronized by pushing local `main` to
  `origin/main` after its fast-forward update.

## Required integration sequence

Before merging any work branch into `macos`, synchronize with the original repo,
even if it was fetched earlier in the task. Start with a clean working tree
(commit the work first); do not discard unrelated changes.

With these fork remotes:

```sh
git fetch upstream
git switch main
git merge --ff-only upstream/main
git switch macos
git merge main
git switch <work-branch>
git merge macos
# Resolve conflicts and run checks appropriate to the final changes.
git switch macos
git merge --squash <work-branch>
git commit
```

If `main` cannot fast-forward, investigate the divergence rather than resetting
or rewriting it. Resolve and validate upstream integration before proceeding.

Keep upstream synchronization as ordinary merges (allow merge commits when
histories diverge), preserving upstream ancestry. Merge updated `macos` into the
work branch before final validation. Squash work branches by default; use an
ordinary merge when a larger change has useful individual commits to preserve.
Do not rebase or force-push published/shared history by default. Leave the
working checkout on `macos` after successful integration.

## macOS port scope and validation

Read the macOS section of `README.md` before changing platform behavior or builds.
The game runs in CrossOver and is assumed to be running and writing journals when
this app starts. macOS supports browser and Electron main-app experiences, with
no HUD overlays or game-process/focus polling. Preserve the existing Windows and
Linux behavior when making platform-specific changes.

Use Node 24 (at least 24.15) and the committed lockfile (`npm ci`). For code changes,
run relevant tests, `npm run typecheck`, and `npm run lint`. For packaging or runtime
changes, build and exercise the affected macOS release using the README commands.
Documentation-only changes need a diff/format review, not a full release rebuild.
Keep generated artifacts, private planning notes, and real commander journals out
of commits. `.gitignore` explicitly allows only selected Markdown files; whitelist
new public documentation deliberately.
