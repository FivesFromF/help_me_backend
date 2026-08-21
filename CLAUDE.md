# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Read `docs/` first. Do not crawl the source tree to learn how this system works.**

`docs/` is an Obsidian vault and the maintained source of truth for architecture, services, and APIs. It is written to answer the questions you would otherwise burn a dozen file reads on. Start at [[docs/00_Overview]] — it indexes every page and carries the question→page map that routes you to the one page you need.

## How to work here

1. **Answer from `docs/`.** For any question about behaviour, structure, endpoints, or setup, the answer is in the vault. Read the one relevant page, not the directory.
2. **Open source files only when you are changing them**, or when the docs are silent on the specific detail you need. Reading `src/` to build a mental model is wasted context — that is what the vault is for.
3. **When docs and code disagree, the code wins as fact and the doc is a bug.** Say so, and offer to correct the page.
4. **Read one session log, never the folder.** `docs/Sessions/` gains a file per session (written by the `/compress` skill in `.claude/skills/`) and only grows. It is an archive, not context. When you need recent history, take the newest filename (they sort chronologically) and read its summary sections — Quick Reference, Decisions, Learnings, Pending Tasks. The `Raw Session Log` at the bottom is there to be searched with `grep`, not read. Older logs are for looking a specific thing up, not for catching up.
5. **Changed behaviour means changing the doc too.** A new endpoint, a changed event, a new env var, a moved port — update the matching page in the same breath. A vault that drifts is worse than no vault, because it is still trusted.

## Orientation

One TypeScript tree (`src/`, one `tsconfig.json`, one Prisma client, one `src/shared/`) that produces four independently deployed things, plus a Python service that npm never touches:

| Path | Deployable | Built by |
| :-- | :-- | :-- |
| `src/services/write-server/` | Express API `:8080` — mutations, Postgres writes, publishes to EventBridge | `tsc` + own `Dockerfile` |
| `src/services/read-server/` | Express API `:8081` — queries, NFC/QR/face emergency lookups | `tsc` + own `Dockerfile` |
| `src/services/ai-server/` | Python SQS consumer — 512-d face embeddings, `pgvector` match | `requirements.txt` / `Dockerfile` |
| `src/functions/*/handler.ts` | AWS Lambdas — `audit-worker`, `grant-permission-worker`, `notification-worker`, `post-confirmation` | `node build.js` (esbuild → zip → `infra/modules/`) |

CQRS: the two Express servers are the write/read pair, and everything asynchronous hangs off EventBridge. `infra/` is Terraform (real cloud); `local-infra/` is a Serverless-offline emulation stack and is never deployed. Details: [[Architecture/Code_Layout]], [[Architecture/CQRS_Pattern]], [[Architecture/EventBridge_Sync]].

## Commands

```bash
# Local stack — Postgres 16 + pgvector on :5432, DynamoDB Local on :8001
docker compose up -d db dynamodb dynamodb-init   # dynamodb-init creates the 3 tables, then exits (idempotent)
npm run prisma:generate && npm run db:push && npm run db:seed

# Run the services (separate terminals)
npm run dev:write     # :8080, watch mode
npm run start:read    # :8081 — there is no dev:read
cd src/services/ai-server && pip install -r requirements.txt && python main.py

# Build
npm run build         # prisma generate && tsc && node build.js  ← use this before `terraform apply`
npm run build:server  # tsc only: no Prisma client, no Lambda zips
```

There is no linter and no test framework. `tsc` (`npm run build:server`) is the type check, and the suites are hand-rolled runners:

```bash
npm run test:api                      # 59 in-process API checks; needs db + dynamodb (Step 1)
npm run test:notify -- you@example.com  # opt-in: sends ONE real email through the configured SMTP
npm run test:ai                       # Python biometric pipeline over test/ai-test/test-images/input/
python test/ai-test/process_images_to_json.py --search <image>   # top-3 match against the local JSON db
```

`npm run test:api` is all-or-nothing — no filter flag. To run one group, call its exported `run*ApiTests` from a tsx script that imports `./event_capture` **first** (see below), or comment out the other groups in `test/api-test/index.ts`. Every run overwrites `docs/Testing/Test_Report.md`; `R-03` fails by design against a real consent defect (`test/api-test/README.md`, note F). The full expected-status catalogue lives in that README, and the runbook is [[Runbooks/Local_Testing]].

## Things that will waste your time if you don't know them

- **Event publishing is best-effort.** A dead or misconfigured EventBridge endpoint logs `[events] failed to publish` and never changes an HTTP status. The entire async path — audit, notifications, permission grants — can be dead while every API test passes. Check the publish warnings before you debug the worker.
- **`.env` edits mid-session do nothing.** `dotenv.config()` never overwrites a var already in `process.env`, so a shell that inherited the old value keeps it for its whole life. Restart the shell, or override per command (`env -u VAR npm run test:api`).
- **Module-level config binding.** `events.service.ts`, `s3.service.ts` and the workers read endpoints, table names and SMTP config into constants at *import* time. Any test sink must be wired before the module is imported — that is why `event_capture.ts` is the first import in `test/api-test/index.ts` and the SMTP group uses dynamic `await import()`.
- **Header auth is not gated by `SKIP_AUTH`.** `authenticate` in `src/shared/middleware/auth.ts` trusts `x-cognito-id` / `x-role` whenever the header is present, and `extractRole` collapses everything that is not `admin` to `citizen` (so `staff` is a fail-open citizen). Docker containers do not get `SKIP_AUTH`, so expect `401` there where the in-process suite gets `404`.
- **Terraform consumes checked-in zips.** `node build.js` writes them into `infra/modules/lambda/`; applying without rebuilding silently deploys old code.

## Conventions

- Vault pages link with Obsidian `[[wikilinks]]` — keep that style when editing docs.
- Much of the backend code carries Vietnamese comments and log strings. Match the surrounding language when editing a file.
- Secrets come from `.env` and Terraform vars (`*.tfvars` is gitignored). Never read them into the transcript or write them into docs.
