# Session: 21-08-2026 23:06 - api-test-coverage-expansion

## Quick Reference
**Topics:** api tests, EventBridge assertions, worker effects, SMTP capture, async face jobs, test report, CLAUDE.md restructure, auth bypass, git commit splitting
**Projects:** `help_me_backend` (test suite, docs vault, event workers)
**Outcome:** API suite grew 39 → 59 checks (58 passing) with three new groups — domain events, worker effects, async job lifecycle — plus a generated report at `docs/Testing/Test_Report.md`; `CLAUDE.md` was reduced to rules only, and a header-based authentication bypass was found and documented.

## Decisions Made
- **`CLAUDE.md` holds no facts — not even the map or the commands.** Three successive rounds stripped it: rule 4 removed, then the code-layout section moved to a new [[Architecture/Code_Layout]] page, then the question→page table and the whole `Commands` block deleted. Beat the alternative of keeping a routing table in `CLAUDE.md` for the one file-read it saves; the map now lives canonically in [[00_Overview]].
- **The event assertions run against an in-suite sink on `:4610`, not the `:4010` emulator.** `event_capture.ts` repoints `EVENTBRIDGE_ENDPOINT` before the routers load. Beat depending on `local-infra`: no prerequisite, no collision when that stack already owns `:4010`, and deterministic because every publish is awaited inside its handler.
- **Worker checks invoke the handlers directly rather than through the emulator.** Beat a full `serverless offline` round trip, which would mean polling for a Lambda that may never fire; direct invocation still exercises the same handler code Terraform deploys.
- **The live email path is a separate opt-in script, never part of `npm run test:api`.** `npm run test:notify -- <address>` with no default recipient. Beat gating it behind an env var inside the suite, which would leave a real send one typo away.
- **The async pipeline is tested at both ends with the worker's DynamoDB write simulated.** Beat waiting on the real S3 → SQS → `worker.py` leg, which is blocked on the bucket-name mismatch below and already covered on the Python side by `test/ai-test/`.
- **Known gaps are rendered into every report run.** A maintained `PENDING` list in `report.ts` sits under the failures, so "58/59" cannot read as completeness.
- **Commits were split line-by-line across shared files** rather than lumping four features together, using a backup → reduce → stage → restore flow in the scratchpad.

## Key Learnings
- **Header authentication is not gated by `SKIP_AUTH`.** `src/shared/middleware/auth.ts` defines `SKIP_AUTH` but never checks it on the `x-cognito-id` branch, so the header path is live in every environment. Confirmed against the running containers, which do **not** receive `SKIP_AUTH`:
  - no auth → `401`
  - `x-cognito-id: totally-made-up-user` → `404` (authenticated as that user, then not-found)
  - plus `x-role: admin` → `403` (role taken from the header, then RBAC applied)
  The `404`/`403` are the *authorization* layer answering; authentication was already skipped. Promoted to [[Architecture/Authentication_and_Audit]].
- **`.env` shadowing bites at module scope, not just at startup.** `events.service.ts`, the workers and `s3.service.ts` all bind endpoint/table/SMTP config into module-level `const`s at import time. Any test that wants to redirect them must set `process.env` *before* the import — hence `event_capture.ts` being imported first in `index.ts`, and the worker group using dynamic `await import()`.
- **`.env` pointed `SMTP_HOST` at a real provider (`smtp.gmail.com`) with real credentials.** A naive notification-worker test would have emailed live emergency contacts. The sink override must therefore precede the handler import, not follow it.
- **Three different bucket names are in play** and no two agree: `.env` signs URLs for `AWS_S3_BUCKET=helpme-avatars-bucket`, `local-infra/serverless.yml` creates `helpme-avatars-local`, and `upload.routes.ts:21` reads a third (`S3_AVATARS_BUCKET_NAME`, absent from `.env`) into a variable it never uses. Presigned URLs are signed for a bucket the emulator does not have.
- **`AUDIT_TABLE_NAME` was missing from `.env`**, so the audit worker dropped every event (`[audit] AUDIT_TABLE_NAME not set`). Unlike `SCAN_JOBS_TABLE`, which `job.service.ts:12` defaults, the audit worker has no fallback. The user added it mid-session.
- **`tsconfig.json` includes only `src/**`**, so `npx tsc --noEmit` says nothing about `test/`. Typechecking the suite needs an explicit invocation against `test/api-test/index.ts`.
- **A green check that cannot go red is worthless.** Both new assertion styles were negative-controlled before being trusted: renaming an expected event to `citizen.profile.NEVER_EMITTED` turned EV-01 red with `captured: citizen.profile.updated@helpme-system-bus`; commenting out `grantMain` turned WK-01 red and WK-02 into a `403`.
- **`PowerShell` here-string syntax (`@'...'@`) silently corrupts a Bash heredoc** — the first commit of the session landed with literal `@` lines in its message and had to be amended.
- **Chained `str.replace()` without assertions hides failed doc edits.** One "Seventeen checks need DynamoDB" edit never applied because of a line-wrap mismatch; it was only caught days-later-style, while reconstructing intermediate states for the commit split.

## Pending Tasks
- [ ] **Fix the header auth bypass** — gate the `x-cognito-id` branch behind `SKIP_AUTH`. User is taking this one. Note the coupling: all 59 checks authenticate by header, so they must then run with `SKIP_AUTH=true`.
- [ ] **Test `post-confirmation`** — the only worker with no coverage; sole writer of the citizen skeleton row on signup.
- [ ] **Settle the three bucket names**, then test the real S3 → SQS → `worker.py` leg.
- [ ] **Remove the dead `s3Bucket` variable** in `upload.routes.ts:21`.
- [ ] Decide whether `docs/Testing/Test_Report.md` should stay tracked — it is regenerated on every run and shows dirty each time.
- [ ] Open defects the suite documents rather than fixes: `R-03` (partial edit silently grants consent, `citizen.routes.ts:29-30`), row 22 (admin `citizenId` unvalidated → `500` instead of `404`), row 37 (unknown role fails open to `citizen`).

## Project Structure
```
help_me_backend/
├── CLAUDE.md                      — map to the vault; deliberately holds no facts (this session emptied it)
├── build.js                       — esbuild+zip for src/functions/*; copies zips into infra/modules/lambda/
├── docker-compose.yaml            — db, dynamodb, dynamodb-init, ai-server, write-server, read-server
├── package.json                   — test:api (suite), test:notify (opt-in live email), test:ai (Python)
├── docs/                          — Obsidian vault, source of truth
│   ├── 00_Overview.md             — index + question→page map (moved here from CLAUDE.md)
│   ├── Architecture/
│   │   ├── Code_Layout.md         — NEW: one tree, four deployables; build topology
│   │   ├── Authentication_and_Audit.md — auth flow, RBAC, audit catalog (gained the bypass warning)
│   │   ├── EventBridge_Sync.md    — buses + workers (gained "What is verified")
│   │   ├── CQRS_Pattern.md, Database_Schema.md, *.canvas
│   ├── Runbooks/Local_Testing.md  — how to run everything locally; prerequisites per check group
│   ├── Services/                  — Write_Server, Read_Server, AI_Server, API_Reference_and_Tests
│   ├── Testing/Test_Report.md     — GENERATED by every test:api run; do not hand-edit
│   └── Sessions/                  — this log
├── src/
│   ├── services/write-server/     — :8080 Express, routes/ (citizen, nfc, emergency, upload, health)
│   ├── services/read-server/      — :8081 Express, routes/ (scan, victim, citizen)
│   ├── services/ai-server/        — Python SQS consumer; own Dockerfile/requirements, not built by npm
│   ├── functions/                 — four Lambda handlers: audit, grant-permission, notification, post-confirmation
│   └── shared/                    — db/ (prisma), middleware/auth.ts, services/ (ai, events, hash, job, s3)
├── test/
│   ├── api-test/                  — the 59-check suite
│   │   ├── index.ts               — seeds one citizen, runs every group, tears down, writes the report
│   │   ├── test_helper.ts         — in-process Express apps on ephemeral ports + recordTest
│   │   ├── event_capture.ts       — NEW: EventBridge sink on :4610; MUST be imported before the routers
│   │   ├── smtp_capture.ts        — NEW: minimal SMTP sink on :2525; keeps alerts off the real provider
│   │   ├── report.ts              — NEW: renders docs/Testing/Test_Report.md incl. the PENDING gap list
│   │   ├── events.api.test.ts     — NEW §9: each route publishes its event to the right bus
│   │   ├── workers.api.test.ts    — NEW §10: what the workers do with those events (WK-02 = the chain)
│   │   ├── jobs.api.test.ts       — NEW §11: async face-pipeline job lifecycle
│   │   ├── live_notify.ts         — NEW: opt-in real email, never part of test:api
│   │   ├── registration.api.test.ts, citizen/nfc_scan/emergency api tests
│   │   └── README.md              — the case catalogue; source of truth for expected status codes
│   └── ai-test/                   — Python biometric extraction/matching (covers the AI pipeline)
├── local-infra/                   — serverless-offline emulators (S3/DynamoDB/SQS/EventBridge); dev-only
└── infra/                         — Terraform; consumes the Lambda zips build.js drops in modules/lambda/
```

---

## Raw Session Log

**U:** `/init` — "Please analyze this codebase and create a CLAUDE.md file…"

Found an existing docs-first `CLAUDE.md`. Improved it: restored the question→page map (the umbrella repo points at it and rule 4 referenced a table that had been deleted from the working copy), added a "Shape of the code" section and a `Commands` block, and prefixed the required `/init` header. Noted no Cursor/Copilot/Codex/Gemini configs existed to import.

**U:** "remove the rule 4 and modify again"

Deleted rule 4, renumbered 5→4 and 6→5, and repointed the map table's `docs/Sessions/` row from "see rule 5" to "see rule 4".

**U:** "the map or shape of the code should be in docs/ as well"

Created `docs/Architecture/Code_Layout.md` (one tree/four deployables, the `build.js` → `infra/modules/lambda/` zip flow, the `authorizer` entry with no handler dir, dev-only dirs, best-effort events). Added it to `00_Overview` Quick Navigation and appended the question→page map there as a table. Removed "Shape of the code" from `CLAUDE.md`.

**U:** "remove The map, Commands section and commands as well"

`CLAUDE.md` reduced to: header, docs-first directive, five rules, three conventions. Before deleting, promoted the one fact that lived nowhere else (the runner has no filter flag; groups share fixtures seeded by `index.ts`) into `API_Reference_and_Tests.md`, and fixed a drift there — it listed three per-domain test files but `index.ts` also imports `registration.api.test.ts`.

**U:** `/commit`

Three commits: `test(api): expand suite to 39 checks…`, `feat(local-infra): add DynamoDB Local to the compose stack`, `docs(vault): move code layout and page map into docs/`. The first landed with literal `@` lines because PowerShell here-string syntax was used in the Bash tool; amended (hash `a0fe796` → `f81fae7`). Left `.obsidian/graph.json` (UI churn) and `.claude/` uncommitted.

**U:** "commit .claude/ too"

`chore(claude): share the commit and compress skills` — scanned first; the only `secret`/`token` hits were the rules' own text.

**U:** "command to ignore the tracked file with git"

**U:** "i want to continue to test"

Ran the suite: `38/39 Passed`, the one failure being the documented `R-03`. Offered four directions.

**U:** *(chose)* "§9 event assertions"

Built `event_capture.ts` (sink on `:4610`, repoints `EVENTBRIDGE_ENDPOINT` before the routers load) and `events.api.test.ts` (EV-01…EV-07). All seven passed first try, so ran a negative control:

```
❌ [PUT /api/citizen/profile] Profile update publishes → "citizen.profile.NEVER_EMITTED" -> Expected: 200, Got: 200
   ⚠️ Details: expected "citizen.profile.NEVER_EMITTED" on bus "helpme-system-bus" — captured: citizen.profile.updated@helpme-system-bus
```

**U:** "where are the test cases report stored?"

Nowhere — console only. `TestResult[]` in memory, printed, `process.exit(1)` on failure.

**U:** "create a centralized test report file in docs/"

Added `report.ts` → `docs/Testing/Test_Report.md` (per-suite totals, failures first, full check list). Suite reached 46 checks, 45 passing.

**U:** `/commit`

Two commits, splitting `index.ts` and three doc files line-by-line: `test(api): assert the §9 domain events with an in-suite sink` and `test(api): write each run to docs/Testing/Test_Report.md`.

**U:** "i have tested the ai service already (some thing in the @test/ai-test) — i towards the option 2."

Option 2 = worker effects. Read the handlers, then found `AUDIT_TABLE_NAME` missing from `.env` and `SMTP_HOST` pointing at a real provider. Built `smtp_capture.ts` and `workers.api.test.ts` (WK-01…WK-07). Negative control on the chain:

```
❌ [EVENT grant-permission-worker] victim.identified grants a 1-hour access session -> Expected: 1, Got: 0
   ⚠️ Details: no session row at responder-worker-01#9ebd9c0b-… in helpme-access-sessions
❌ [GET /api/victim/:victimId] Session written by the worker unlocks the victim record -> Expected: 200, Got: 403
```

**U:** "MTP_HOST in .env is a real provider… --> can test real here / 1. i have set it"

Confirmed `AUDIT_TABLE_NAME` now present. Built `live_notify.ts` + `npm run test:notify`, asked for the recipient, and sent a real email to the user's own address:

```
✅ SMTP transport verified (credentials accepted)
[notify] alerted 1 contact(s) for citizen b3a81fc6-…
✅ notification-worker sent the alert to mndkhanh@gmail.com
```

Verified cleanup: `leftover probe citizens: 0 []`.

**U:** "what to test next"

Probed the running containers and found the header auth bypass (`401` with no header, `404` with a forged one). Ranked: fix auth first, then the async pipeline, then `post-confirmation`.

**U:** "3. note again in test report for me to test / 2. test this / 1. lemme test later, note it"

Built `jobs.api.test.ts` (AP-01…AP-06) — suite reached 59 checks, 58 passing — and added the `PENDING` list to `report.ts` covering the auth bypass, `post-confirmation`, the face paths and the S3→SQS leg. Found the three-way bucket-name mismatch while reading `upload.routes.ts`.

**U:** `/commit`

Four commits (`a75df39`, `7aff93d`, `cd211b5`, `d4f6bc6`). The reconstruction caught a doc edit that had silently failed — `API_Reference_and_Tests.md` still said "Seven checks need DynamoDB" — and a paragraph in `Local_Testing.md` that successive edits had mangled onto one line. Both fixed.

**U:** `/compress`

This log, plus the promotions below.
