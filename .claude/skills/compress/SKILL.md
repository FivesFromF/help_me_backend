---
name: compress
description: Compress the current session into a searchable log under docs/Sessions/, then fold anything permanent into the matching docs/ page. Invoked only when the user explicitly asks to compress.
---

# Compress

Two passes, in order:

1. **Archive the session** — write everything that happened to `docs/Sessions/`, so it stays searchable long after the context is gone.
2. **Promote what outlives it** — fold the handful of facts that will still be true next month into the `docs/` page that owns them.

The split is the whole point. The log is *what happened*; the vault is *what is true*. A fact that belongs in both goes in both — full context in the log, one line in the page.

Everything lands in `docs/`. Nothing durable goes into `CLAUDE.md` — that file is a map to the vault, not a store of facts.

---

# Pass 1 — the session log

## Where it goes

`docs/Sessions/YYYY-MM-DD-HHmm-<slug>.md`, relative to the repo root you are working in.

- Get the date and time from `date`, never from memory — the model's idea of "now" is unreliable.
- `<slug>` is 2–5 kebab-case words naming what the session was about (`registration-api-tests`, not `session-log`).
- Create `docs/Sessions/` if it does not exist.
- If the file already exists, the session continued: update it in place rather than writing a second file.

## Format

````markdown
# Session: DD-MM-YYYY HH:MM - <slug>

## Quick Reference
**Topics:** comma-separated keywords someone would actually search for
**Projects:** which submodule(s) or component(s) this touched
**Outcome:** one line — what is different now that wasn't before

## Decisions Made
- The choice, and the alternative it beat

## Key Learnings
- Non-obvious facts discovered: gotchas, surprising API behaviour, root causes

## Pending Tasks
- [ ] Unfinished work, open offers the user never answered

## Project Structure
```
<annotated tree — see rules below>
```

---

## Raw Session Log
[Full conversation archived below for searchability]
````

## Capturing the project structure

Snapshot the tree as it stands **at the end of the session**, so the log explains itself later.

- Build the file list with `git ls-files` (or `git ls-files <dir>`), not `find` or `tree`. It already honours `.gitignore`, so `node_modules/`, `dist/`, and build output stay out — a raw recursive listing is unusable and mostly noise.
- Include untracked-but-real files with `git ls-files --others --exclude-standard`.
- Annotate every entry with **what it does**, not what it is named. `router.ts — converts the API-GW event into a web Request` is useful; `router.ts — router` is not.
- Depth is not uniform. Files the session touched get a line each; everything else collapses to one line per directory. The point is orientation, not an inventory.
- Note structure that is not obvious from the names: which directories are vendored or generated, which are dead code, where the entry points are.
- In a submodule, cover that submodule. Only walk up to the umbrella repo if the session actually spanned more than one.

## Rules for the log

- Drop a section only if it would be genuinely empty. Never invent entries to fill one.
- **Decisions** are choices with alternatives. **Learnings** are facts the codebase did not already state. Something already written in the code or docs belongs in neither.
- Raw Session Log: user messages verbatim, your side condensed to what was done and what it produced. Keep error messages and commands exactly as they appeared — that is what makes the log searchable.
- For higher fidelity, read the session transcript at `~/.claude/projects/<project-slug>/<session-id>.jsonl` (the most recently modified `.jsonl` in that directory) instead of relying on remaining context, which may already be compacted.
- Link related notes with `[[wikilinks]]` so the vault graph connects.

---

# Pass 2 — fold into the vault

`docs/` is the source of truth for this repo. A durable fact belongs on the page that already owns its topic:

| The fact is about | Page |
| :-- | :-- |
| How reads and writes split | `docs/Architecture/CQRS_Pattern.md` |
| Tables, models, migrations | `docs/Architecture/Database_Schema.md` |
| Events, workers, async flow | `docs/Architecture/EventBridge_Sync.md` |
| Auth, roles, audit | `docs/Architecture/Authentication_and_Audit.md` |
| A specific service's behaviour | `docs/Services/<Service>.md` |
| Endpoints, payloads, test coverage | `docs/Services/API_Reference_and_Tests.md` |
| Running, testing, or emulating locally | `docs/Runbooks/Local_Testing.md` |

## What qualifies

Only what is worth knowing at the *start* of a future session:

- Project conventions and standards
- Architecture decisions, and why they were made
- Key file paths, ports, env vars
- Common workflows and commands
- Behaviour that surprised you and will surprise the next reader

## What does not

- Anything true only of this session — that is the log, and it is already written.
- Anything the page already says. If it is there, do not restate it; duplication is how a vault goes stale.

Most sessions promote **nothing**. That is the normal outcome, not a failure — say so and move on.

## Folding it in

1. Read the target page first and find the section the fact belongs in.
2. Write it as the page's own voice — present tense, describing how the system *is*. Not "we changed X today"; the vault has no today.
3. If the fact contradicts a line already there, **replace that line**. Never leave both. A page with two answers is worse than one with none.
4. Convert relative dates ("last week") to absolute ones.
5. Link related pages with `[[wikilinks]]` so the graph stays connected.

## When no page fits

Only then, create one — in the folder that matches its kind (`Architecture/`, `Services/`, `Runbooks/`), named in `Title_Case.md` to match its neighbours.

A new page is not finished until it is reachable:

- Add it to the Quick Navigation list in `docs/00_Overview.md`.
- Add a row to the question→page table in `CLAUDE.md`.

Those are pointers, not facts — the only thing `CLAUDE.md` ever gains from this skill.

## Keeping pages honest

- A page describes the system as it is now. Superseded content is not left sitting next to its replacement.
- Worth keeping for its rationale? Move it to `docs/Archive/<Original_Name>.md` under an `## Archived YYYY-MM-DD` heading (date from `date`), and leave a one-line pointer where it stood, e.g. `Earlier Go/ECS design: see [[Archive/CQRS_Pattern]].` Archiving is a move, never a delete.
- If a page stops being about one thing, split it and update both indexes rather than letting it sprawl.

# Rules for both passes

- Report the log path, which pages you edited and what each gained (or that nothing was promoted), and anything you archived.
- Never commit. Never push. Write the files and stop.
- Never write secrets, tokens, `.env` values, or credentials into either file — redact them, or reference where they live.
