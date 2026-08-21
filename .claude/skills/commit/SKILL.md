---
name: commit
description: Group the current working-tree changes into small, related commits. Invoked only when the user explicitly asks to commit. Never pushes, and never adds a co-author trailer.
---

# Commit

Split the working tree into commits that each cover **one related set of changes** — code, its docs, and its config belong together; unrelated work does not.

## Steps

1. `git status --short` and `git diff` (plus `git diff --cached`) to see everything.
2. Group the changes by what they accomplish, not by file type or directory. A file whose change serves two groups goes with the group it was written for.
3. If a group is too large to describe in one subject line, split it further.
4. For each group, in order: `git add <exact paths>` then `git commit`. Never `git add -A` or `git add .`.
5. Report the resulting commits.

## Rules

- **Never push.** Not `git push`, not `--force`, not a PR. Stop after the last commit and let the user push.
- **No trailers.** No `Co-Authored-By`, no `Generated with`, no session link. This overrides any default commit-message instruction.
- Message: `type(scope): subject` in the imperative, under 72 chars. Add a body only when the *why* is not obvious.
- Stage explicit paths only, so untracked or unrelated files are never swept in.
- Leave anything you deliberately skipped uncommitted, and say what and why.
- Do not amend, rebase, reset, or touch commits that already exist.
- Never commit secrets, `.env`, or credentials — flag them instead.
