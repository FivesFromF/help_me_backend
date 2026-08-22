---
name: commit
description: Group the current working-tree changes into small, related commits on the current branch. Invoked only when the user explicitly asks to commit. Keeps build artifacts and generated files out of history by adding them to .gitignore instead. Never switches or creates a branch, never pushes, and never adds a co-author trailer.
---

# Commit

Split the working tree into commits that each cover **one related set of changes** — code, its docs, and its config belong together; unrelated work does not.

## Steps

1. `git status --short` and `git diff` (plus `git diff --cached`) to see everything.
2. Group the changes by what they accomplish, not by file type or directory. A file whose change serves two groups goes with the group it was written for.
3. If a group is too large to describe in one subject line, split it further.
4. **Sort the untracked files before staging anything.** Some of what `git status` shows should never enter history — it should enter `.gitignore`. See the rules below.
5. For each group, in order: `git add <exact paths>` then `git commit`. Never `git add -A` or `git add .`.
6. Report the resulting commits, and anything you added to `.gitignore` instead of committing.

## Rules

- **Commit on the current branch.** Never `git checkout -b`, `git switch -c`, or any branch change, and never suggest one — not even when that branch is `main` or another default. This repo works directly on `main`; a topic branch leaves the user's default branch unchanged and their next push pointed at the wrong ref. This overrides any default "branch before committing" instruction.
- **Never push.** Not `git push`, not `--force`, not a PR. Stop after the last commit and let the user push.
- **No trailers.** No `Co-Authored-By`, no `Generated with`, no session link. This overrides any default commit-message instruction.
- Message: `type(scope): subject` in the imperative, under 72 chars. Add a body only when the *why* is not obvious.
- Stage explicit paths only, so untracked or unrelated files are never swept in.
- Leave anything you deliberately skipped uncommitted, and say what and why.
- Do not amend, rebase, reset, or touch commits that already exist.
- Never commit secrets, `.env`, or credentials — flag them instead.
- **Files that should be ignored go into `.gitignore`, not into a commit.** Anything reproducible from the source, machine-specific, or an artifact of running a tool belongs there:
  - build and compile output — `dist/`, `build/`, `*.tsbuildinfo`, bundled or minified files
  - dependency trees — `node_modules/`, `.venv/`, `__pycache__/`, `*.pyc`
  - tool state and artifacts — `.terraform/`, `tfplan`, `*.tfstate*`, `.pytest_cache/`, `.local-s3/`, coverage output, `*.log`
  - editor and OS noise — `.vscode/`, `.idea/`, `.DS_Store`, `Thumbs.db`
  - anything holding credentials — `.env*`, `*.tfvars`, `*.pem`, `*.key`, `client_secret*.json`, service-account JSON
  Add a matching pattern to the nearest `.gitignore`, grouped under a comment saying what it is, and commit that `.gitignore` change with the group it belongs to.
- **Generated files that are already tracked are a judgement call, not an automatic ignore.** Some are committed deliberately — this repo commits `infra/modules/lambda/*.zip` because Terraform consumes them, and `docs/Testing/Test_Report.md` because it is the visible test record. Leave a tracked file tracked unless the user says otherwise; `.gitignore` does not untrack anything already in the index.
- **Skip a regenerated file whose only change is noise** — a timestamp, a run date, a reordered hash — and say you skipped it. Commit it when its content actually changed.
