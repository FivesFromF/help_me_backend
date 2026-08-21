# CLAUDE.md — help_me_backend

**Read `docs/` first. Do not crawl the source tree to learn how this system works.**

`docs/` is an Obsidian vault and the maintained source of truth for architecture, services, and APIs. It is written to answer the questions you would otherwise burn a dozen file reads on. Start at [[docs/00_Overview]], which indexes everything below.

## The map

| Question | Read |
| :-- | :-- |
| What is this system, and what are its moving parts? | `docs/00_Overview.md` |
| How do reads and writes split? | `docs/Architecture/CQRS_Pattern.md` |
| What tables/models exist? | `docs/Architecture/Database_Schema.md` |
| How do async events and workers flow? | `docs/Architecture/EventBridge_Sync.md` |
| How does auth work, and what gets audited? | `docs/Architecture/Authentication_and_Audit.md` |
| What does the write server (`:8080`) do? | `docs/Services/Write_Server.md` |
| What does the read server (`:8081`) do? | `docs/Services/Read_Server.md` |
| How does face recognition work? | `docs/Services/AI_Server.md` |
| What endpoints exist, and what is tested? | `docs/Services/API_Reference_and_Tests.md` |
| How do I run or test this locally? | `docs/Runbooks/Local_Testing.md` |
| Visual architecture | `docs/Architecture/*.canvas` (Obsidian canvas, JSON) |
| What was worked on recently? | `docs/Sessions/` — **newest file only**, see rule 5 |

## How to work here

1. **Answer from `docs/`.** For any question about behaviour, structure, endpoints, or setup, the answer is in the vault. Read the one relevant page, not the directory.
2. **Open source files only when you are changing them**, or when the docs are silent on the specific detail you need. Reading `src/` to build a mental model is wasted context — that is what the vault is for.
3. **When docs and code disagree, the code wins as fact and the doc is a bug.** Say so, and offer to correct the page.
4. **This file holds no facts — only the map.** Everything durable lives on a vault page. If you learn something worth keeping, it goes in `docs/`, and this table gains a row only when a brand-new page appears.
5. **Read one session log, never the folder.** `docs/Sessions/` gains a file per session and only grows. It is an archive, not context. When you need recent history, take the newest filename (they sort chronologically) and read its summary sections — Quick Reference, Decisions, Learnings, Pending Tasks. The `Raw Session Log` at the bottom is there to be searched with `grep`, not read. Older logs are for looking a specific thing up, not for catching up.
6. **Changed behaviour means changing the doc too.** A new endpoint, a changed event, a new env var, a moved port — update the matching page in the same breath. A vault that drifts is worse than no vault, because it is still trusted.

## Conventions

- Vault pages link with Obsidian `[[wikilinks]]` — keep that style when editing docs.
- Much of the backend code carries Vietnamese comments and log strings. Match the surrounding language when editing a file.
- Secrets come from `.env` and Terraform vars. Never read them into the transcript or write them into docs.
