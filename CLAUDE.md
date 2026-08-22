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
| `src/functions/*/handler.ts` | AWS Lambdas — `audit-worker`, `notification-worker`, `post-confirmation` | `node build.js` (esbuild → zip → `infra/modules/`) |

CQRS: the two Express servers are the write/read pair, and everything asynchronous hangs off EventBridge. `infra/` is Terraform (real cloud, deployed 2026-08-22 — endpoints and shipping steps in [[Runbooks/Cloud_Deployment]]); `local-infra/` is a Serverless-offline emulation stack and is never deployed. Details: [[Architecture/Code_Layout]], [[Architecture/CQRS_Pattern]], [[Architecture/EventBridge_Sync]].

## Commands

```bash
# Local stack — Postgres 16 + pgvector :5432, DynamoDB Local :8001, ElasticMQ (real SQS) :9324
docker compose up -d db dynamodb dynamodb-init elasticmq   # dynamodb-init creates the 3 tables, then exits (idempotent)
npm run prisma:generate && npm run db:push && npm run db:seed
npm run db:studio     # Prisma Studio;  npm run ddb:admin = dynamodb-admin on :8002 against DynamoDB Local

# Host-side AWS emulators — S3 :4569, EventBridge :4010, offline Lambda HTTP :3000
cd local-infra && npm start        # Serverless-offline; runs on the HOST, never deployed

# Run the services (separate terminals)
npm run dev:write     # :8080, watch mode  (npm run start:write = same, no watch)
npm run start:read    # :8081 — there is no dev:read
cd src/services/ai-server && pip install -r requirements.txt && python main.py

# Cloud ops (PowerShell, Windows) — see scripts/
./scripts/cloud-start.ps1   # wake ECS services + RDS + bastion;  cloud-stop.ps1 puts them back to sleep
./scripts/deploy.ps1 -Target all|write|read|ai|<lambda-name>   # build+push ECR images / Lambda zips to the deployed stack

# Build
npm run build         # prisma generate && tsc && node build.js  ← use this before `terraform apply`
npm run build:server  # tsc only: no Prisma client, no Lambda zips
```

There is no linter and no test framework. `tsc` (`npm run build:server`) is the type check, and the suites are hand-rolled runners:

```bash
npm run test:api                      # 74 in-process API checks across 9 groups; needs db + dynamodb (Step 1)
npm run test:pipeline                 # 7 checks: S3 -> SQS -> worker -> pgvector -> DynamoDB session
npm run test:notify -- you@example.com  # opt-in: sends ONE real email through the configured SMTP
npm run test:ai                       # Python biometric pipeline over test/ai-test/test-images/input/
python test/ai-test/process_images_to_json.py --search <image>   # top-3 match against the local JSON db
```

`npm test` is aliased to `test:ai` (the Python image script), **not** the API suite — always name the suite you want.

`npm run test:api` is all-or-nothing — no filter flag. To run one group, call its exported `run*ApiTests` from a tsx script that sets `process.env.SKIP_AUTH = "true"` and imports `./event_capture` **before any import that reaches a router** (see below), or comment out the other groups in `test/api-test/index.ts`. Every run overwrites `docs/Testing/Test_Report.md`; the suite is green as of 2026-08-22 (**74/74** — was 75 before `WK-07` retired with `grant-permission-worker`). `R-03` ("a partial edit must not silently grant consent") failed by design until the `consentRegulation ?? true` defect in `citizen.routes.ts` was fixed that same day — a red `R-03` now means a regression, not the known bug. The expected-status catalogue, plus the cases that are designed but deliberately not executed (the face *happy* paths, and the `post-confirmation` group `PC-01`–`PC-06`), lives in `test/api-test/README.md`; the runbook is [[Runbooks/Local_Testing]].

Three checks live outside the suite and outside `package.json` — run them with `npx tsx`:

```bash
npx tsx test/api-test/auth_gate_check.ts   # security regression: forged x-cognito-id must 401 with SKIP_AUTH off (exit 0 = gate holds)
npx tsx test/api-test/_expiry_check.ts     # AccessSession grant -> expiry -> revoke, clock wound forward
npx tsx test/ai-test/presign_check.ts      # presigned S3 PUT
```

## Things that will waste your time if you don't know them

- **Event publishing is best-effort.** A dead or misconfigured EventBridge endpoint logs `[events] failed to publish` and never changes an HTTP status. The entire async path — audit, notifications, permission grants — can be dead while every API test passes. Check the publish warnings before you debug the worker.
- **`.env` edits mid-session do nothing.** `dotenv.config()` never overwrites a var already in `process.env`, so a shell that inherited the old value keeps it for its whole life. Restart the shell, or override per command (`env -u VAR npm run test:api`).
- **Module-level config binding.** `events.service.ts`, `s3.service.ts` and the workers read endpoints, table names and SMTP config into constants at *import* time. Any test sink must be wired before the module is imported — that is why `event_capture.ts` is the first import in `test/api-test/index.ts` and the SMTP group uses dynamic `await import()`.
- **Header auth is gated by `SKIP_AUTH`, and the flag binds at import time.** `authenticate` in `src/shared/middleware/auth.ts` trusts `x-cognito-id` / `x-role` only when `SKIP_AUTH === "true"` (that branch was ungated until 2026-08-22, when a forged header was full admin anywhere). It reads the flag into a module constant at load, so any script authenticating by header must assign `process.env.SKIP_AUTH` **before** the import that pulls in a router — hence it being the first statement in `test/api-test/index.ts`. Neither `docker-compose.yaml` nor Terraform sets it, so the same header request that returns `404` in-process returns `401` in a container and in the cloud. `extractRole` still collapses everything that is not `admin` to `citizen`, so `staff` is a citizen.
- **The AI worker's AWS wiring is opt-in local, real by default.** `worker.py` uses localhost emulator endpoints and dummy `test` credentials **only** when `LOCAL_AWS_EMULATION=true`; unset, boto3 resolves real AWS and uses the task role. Host-run (`python main.py`) must set it — `docker-compose.yaml` already does. Inverting this is what cost a day: the localhost defaults were unconditional, so the deployed Fargate worker polled itself and overwrote its own ECS task role, reporting `RUNNING` the whole time. Enrollment jobs stuck at `PENDING` with queue `Available > 0` and `NotVisible: 0` always mean nothing is consuming — check wiring, not the model. [[Services/AI_Server]]
- **Local AWS emulation is split across two hosts.** Postgres, DynamoDB and the SQS queue (ElasticMQ) are Docker Compose services; S3, EventBridge and offline Lambda come from `local-infra` running on the *host*. That is why the composed `ai-server` points at `host.docker.internal:4010` / `:4569` but at `elasticmq:9324` by service name — a container that falls back to `localhost` error-loops forever. `serverless-offline-sqs` is a client-side plugin only: without ElasticMQ nothing listens on `:9324`.
- **The API suite proves nothing about the async path.** `test:api` never touches S3, SQS or the worker, so it stays fully green while the entire face pipeline is dead. `npm run test:pipeline` is what covers it; `test/ai-test/presign_check.ts` covers the presigned `PUT`. Local S3 also has two non-obvious rules — credentials must be `S3RVER`/`S3RVER` and `vhostBuckets` must be `false` — both explained in [[Runbooks/Local_Testing]].
- **Only `plain-avatar.jpg` survives the liveness gate.** Every large `.png` in `test/ai-test/test-images/input/` is a screen capture and is scored FAKE by design, so a happy-path test built on `good.png` fails with `Spoofing detected` and looks like broken infrastructure.
- **Terraform consumes checked-in zips.** `node build.js` writes them into `infra/modules/lambda/`; applying without rebuilding silently deploys old code.

## Conventions

- Vault pages link with Obsidian `[[wikilinks]]` — keep that style when editing docs.
- Much of the backend code carries Vietnamese comments and log strings. Match the surrounding language when editing a file.
- Secrets come from `.env` and Terraform vars (`*.tfvars` is gitignored). Never read them into the transcript or write them into docs.
