# Session: 22-08-2026 00:14 - ai-pipeline-wiring-face-tests

## Quick Reference
**Topics:** CLAUDE.md init, face tests, deprecated sync face path, AI_LAMBDA_NAME, post-confirmation cases, bucket names, ai-server wiring, ElasticMQ, serverless-s3-local, InvalidAccessKeyId, host.docker.internal, pipeline probe, commit splitting
**Projects:** `help_me_backend` (test suite, docs vault, docker-compose, local-infra)
**Outcome:** API suite grew 59 → 63 checks (62 passing) with a new group pinning the deprecated synchronous face path; the AI worker went from a five-hour error loop to reaching all five of its dependencies; three bucket names collapsed to one; two emulator misconfigurations found (`serverless-offline-sqs` serves nothing, `serverless-s3-local` rejects the app's credentials); `CLAUDE.md` regained commands and an orientation table.

## Decisions Made
- **`CLAUDE.md` carries commands and an orientation table again**, reversing the previous session's "holds no facts, not even the commands" decision. `/init` asks for exactly that, and a session otherwise reads a runbook to learn `npm run test:api`. Endpoint tables, schema and status codes stayed in the vault — only the everyday commands and the four-deployables table were duplicated. See [[Sessions/2026-08-21-2306-api-test-coverage-expansion]] for the decision this overturns.
- **The face happy paths were rewritten as failure assertions rather than left pending.** F-01–F-04 assert the 500, the untouched row and the unpublished event. Beat waiting for the AI service, which cannot ever satisfy them (see Learnings).
- **`helpme-avatars-local` is the single local bucket name**, chosen over `helpme-avatars-bucket` because it is already the `s3.service.ts:11` default and what `local-infra` creates — so anything left unset still agrees. Only `.env` had to change, and `.env` is the user's to edit.
- **ElasticMQ runs as a compose service, not inside `local-infra`.** Beat leaving SQS to `serverless-offline-sqs`, which turned out to serve nothing at all. Queues are declared in `local-infra/elasticmq.conf` rather than left to the plugin's `autoCreate`, so the queue exists whether or not the serverless stack is up.
- **MinIO was proposed for S3 and rejected by the user.** The fallback — fixing `serverless-s3-local`'s bind address — turned out to be the better fix anyway, because the root cause was a wrong config key rather than an IPv6 quirk.
- **The emulator was changed to accept the app's credentials, not the reverse.** `s3.service.ts:9` hardcodes `test`/`test` and also runs in production, so `custom.s3.accessKeyId` moved to `test` instead.
- **Commits were split with `git hash-object` + `git update-index`** rather than the previous session's backup → reduce → restore flow. Three files carried changes belonging to different groups; staging reconstructed blobs never touches the worktree, so there is no half-edited state to restore.

## Key Learnings
- **The synchronous face path is dead code in every environment.** `shared/services/ai.service.ts:6` invokes an AI Lambda named by `AI_LAMBDA_NAME` and throws `Synchronous face extraction endpoint is deprecated` when it is unset. A repo-wide search found the variable in **no** `.env`, no `infra/**.tf`, and no compose file. Both callers (`write-server/routes/citizen.routes.ts:131`, `read-server/routes/scan.routes.ts:76`) therefore return 500. Running `python main.py` cannot help: `main.py` is an SQS consumer with no HTTP surface. Promoted to [[Services/AI_Server]].
- **`.env` carries two variables nothing reads.** `AI_SERVER_URL` and `AI_INTERNAL_SECRET` appear in no `src/` or `test/` file — leftovers from an HTTP-based AI service.
- **`post-confirmation` cannot report its own failure.** The whole handler body sits in one `try` whose `catch` only logs, and `main` returns the event regardless. `AdminListGroupsForUser` is the first await, so any Cognito error skips the DB insert entirely; and `email` is `@unique` while a missing attribute defaults to `""`, so a second attribute-less signup collides and is swallowed the same way. Either path leaves a confirmed Cognito user with no citizen row and no retry. Promoted to [[Architecture/EventBridge_Sync]].
- **`post-confirmation` is the only publisher in `src/` that ignores the endpoint variables.** It builds `new EventBridgeClient({})` with no override, unlike `events.service.ts:3`, `job.service.ts:4` and both DynamoDB workers — so `event_capture.ts` cannot capture its events. Testing it needs the SDK's own `AWS_ENDPOINT_URL_EVENTBRIDGE`.
- **`serverless-offline-sqs` is a client, not a server.** Its README: "there should be some queue system actually running." Nothing ran one, so `:9324` never had a listener and the AI worker error-looped for five hours. ElasticMQ (or equivalent) has to be provided separately.
- **`serverless-s3-local`'s bind option is `address`, not `host`.** `index.js:10` defaults `address` to `localhost`, which resolves to `::1` on Windows; `host` is a different option (where the plugin makes its own internal calls) and binds nothing. `netstat` showed `[::1]:4569` while `serverless.yml` said `host: 0.0.0.0`.
- **`serverless-s3-local` rejects any access key but its own.** It defaults `accessKeyId`/`secretAccessKey` to `S3RVER` and answers anything else with `403 InvalidAccessKeyId`. `s3.service.ts:9` signs with `test`/`test`, so **every presigned PUT the API hands out was being refused** — a deeper blocker than the bucket-name mismatch, and one that only surfaced when a real upload was attempted. Verified side by side: `test` → `InvalidAccessKeyId`, `S3RVER` → `OK`.
- **The `ai-server` compose service had no `environment:` block at all**, so `worker.py` used its `localhost` defaults, which inside a container mean the container itself.
- **`docker compose up -d` does not rebuild.** The running `ai-server` image logged `Uvicorn running on http://0.0.0.0:8000` although no FastAPI exists in the source and neither `fastapi` nor `uvicorn` is in `requirements.txt` — a stale image from older code. `--build` was required.
- **Terraform generates the production bucket name** (`infra/modules/s3/main.tf`: `${project_name}-avatars-${random_suffix}`) and injects it as `AWS_S3_BUCKET`, so no local name choice can affect production.
- **A `finally` block containing `process.exit()` swallows the error that reached it.** The first probe run printed one heading and exited 0; the real `InvalidAccessKeyId` only appeared after a `catch` was added ahead of the `finally`.
- **PowerShell here-string syntax (`@'...'@`) inside the Bash tool silently becomes the commit message.** It produced a commit whose subject was `@`; amended immediately. Same trap as the previous session — use `git commit -F -` with a heredoc.
- **The report's "All checks" table is a run record, not a coverage list.** Mapping its 59 rows back to the README catalogue showed the apparent shortfall is duplication (CW-03, CW-03b and CR-02 execute as their Registration twins R-06, R-05, R-08), not absence. The runner emits no case IDs, so this mapping is by name only.

## Pending Tasks
- [ ] **Set `AWS_S3_BUCKET="helpme-avatars-local"` in `.env`** — the last surviving name mismatch. User's file; not in git.
- [ ] **Restart `local-infra`** so the `address: 0.0.0.0` and `accessKeyId: test` changes take effect, then rerun `npx tsx test/ai-test/pipeline_probe.ts` to finish proving the leg. The probe never got a clean run: it aborted on `InvalidAccessKeyId`.
- [ ] **Decide whether `pipeline_probe.ts` becomes `npm run test:pipeline`** — offered, unanswered.
- [ ] **Add the S3 → SQS notification rule** to `local-infra`, or accept that jobs are enqueued by hand. Offered, unanswered.
- [ ] **Test `post-confirmation` (PC-01–PC-06)** — designed in `test/api-test/README.md` §14, assigned to the owner.
- [ ] **Fix the header auth bypass** — carried over, still the owner's.
- [ ] Consider carrying case IDs through `recordTest` so coverage gaps show up automatically instead of being reasoned out by hand.
- [ ] Open defects the suite documents rather than fixes: `R-03` (partial edit grants consent), admin `citizenId` unvalidated → 500, unknown role fails open to `citizen`.

## Project Structure
```
help_me_backend/
├── CLAUDE.md                          — vault map; regained a Commands block and orientation table this session
├── docker-compose.yaml                — db, dynamodb, dynamodb-init, elasticmq (new), ai-server, write/read-server
├── build.js                           — esbuild + zip for src/functions/*; copies zips into infra/modules/lambda/
├── docs/                              — Obsidian vault, source of truth
│   ├── 00_Overview.md                 — index + question→page map
│   ├── Architecture/
│   │   ├── Authentication_and_Audit.md — auth middleware; carries the ungated x-cognito-id warning
│   │   ├── Code_Layout.md              — one tree, four deployables, what builds what
│   │   ├── CQRS_Pattern.md, Database_Schema.md
│   │   ├── EventBridge_Sync.md         — workers and async flow; gained the post-confirmation silent-failure note
│   │   └── *.canvas                    — Obsidian canvases (JSON, not prose)
│   ├── Runbooks/Local_Testing.md      — heavily edited: one bucket name, ElasticMQ, the S3 `address` trap
│   ├── Services/
│   │   ├── AI_Server.md                — gained the deprecated-sync-path section
│   │   ├── API_Reference_and_Tests.md  — check counts and the face-path correction
│   │   └── Read_Server.md, Write_Server.md
│   ├── Sessions/                      — one log per session; read the newest only
│   └── Testing/Test_Report.md         — GENERATED by every `npm run test:api`; never hand-edit
├── infra/                             — Terraform (real AWS); modules/*/*.zip are build.js output, committed
├── local-infra/                       — dev-only emulator stack, never deployed
│   ├── serverless.yml                 — S3/DynamoDB/EventBridge/Lambda emulators; s3.address and s3 creds fixed here
│   └── elasticmq.conf                 — NEW: declares helpme-ai-jobs-queue + DLQ for the elasticmq container
├── prisma/schema.prisma               — citizens.email is @unique; face_embedding is Unsupported("vector(512)")
├── src/
│   ├── functions/                     — Lambda handlers (audit, grant-permission, notification, post-confirmation)
│   ├── services/
│   │   ├── ai-server/                 — Python; main.py is an SQS consumer with NO HTTP surface
│   │   │   ├── worker.py              — SQS → S3 → MediaPipe/anti-spoof/EdgeFace → pgvector → DynamoDB → EventBridge
│   │   │   ├── regconition_original.py — FaceProcessor (sic: filename is misspelled in the repo)
│   │   │   └── anti_spoofing/, edgeface/, face_landmark/ — vendored model code + weights (~37 files)
│   │   ├── read-server/               — :8081; routes/scan.routes.ts holds the FACE branch that 500s
│   │   └── write-server/              — :8080; routes/upload.routes.ts lost its dead s3Bucket variable
│   └── shared/
│       ├── middleware/auth.ts         — header auth is NOT gated by SKIP_AUTH
│       └── services/                  — ai (deprecated sync path), events, hash, job, s3
└── test/
    ├── ai-test/
    │   ├── process_images_to_json.py  — offline embedding extraction / search over test-images/
    │   └── pipeline_probe.ts          — NEW: enqueues a job by hand to drive S3 → SQS → worker.py end to end
    └── api-test/                      — 63 checks, in-process Express on ephemeral ports
        ├── README.md                  — the catalogue; §13 face path, §14 post-confirmation (not implemented)
        ├── index.ts                   — runner; event_capture must stay the first import
        ├── face.api.test.ts           — NEW: F-01–F-04
        ├── report.ts                  — writes docs/Testing/Test_Report.md; PENDING[] is the known-gaps list
        └── event_capture.ts, smtp_capture.ts — in-process sinks on :4610 and :2525
```

---

## Raw Session Log

**User:** `/init` — "Please analyze this codebase and create a CLAUDE.md file..."

Read `docs/00_Overview.md`, `Code_Layout.md`, `package.json`, `test/api-test/README.md`, the runbook, `build.js`, `auth.ts`. Found no README, no Cursor/Copilot/Codex/Gemini configs. Rewrote `CLAUDE.md` keeping all five working rules and adding: an orientation table (four deployables), a Commands block (compose, prisma, build vs build:server, the four test scripts), a note that there is no linter and no test framework, how to narrow an all-or-nothing suite run, and five cross-cutting traps.

**User:** "what to test next"

Read the report's gap list and the previous session's Pending Tasks. Recommended `post-confirmation`: only uncovered worker, sole writer of the citizen skeleton row. Reading `handler.ts` showed every failure is silent (one try/catch, returns the event). Proposed PC-01–PC-06 and flagged that `event_capture.ts` cannot see its events.

**User (mid-turn):** "does the current test report cover all test case?"

No — the report is a run record (59 rows), the README is the catalogue (67 IDs). Mapped them: only W-01 (no route), the face happy paths, and the new PC-* are uncovered; CW-03/CW-03b/CR-02 execute as Registration twins.

**User:** "write a test case in test report then note that it should be tested by me"

Wrote §13 (later §14) into `test/api-test/README.md` with the PC table and note G, rewrote the `PENDING` entry in `report.ts` to "To be tested by the owner", regenerated the report via `npm run test:api` (58/59).

**User:** "what to test next"

Investigated the face group and found it was never AI-blocked:
```
Synchronous face extraction endpoint is deprecated. Use async Presigned S3 upload + SQS AI Worker flow.
```
`AI_LAMBDA_NAME` set nowhere; `main.py` has no HTTP surface. Proposed F-01–F-04 plus the docs corrections.

**User:** "yes, write those tests and fix the docs"

Added `test/api-test/face.api.test.ts`, wired it into `index.ts` (62/63). Negative-controlled by changing the expected message to `quantum-entanglement`: F-01 and F-04 went red, F-02/F-03 stayed green. Corrected four doc claims (README intro/prereq/§9/status table, `report.ts`, runbook Terminal 3 + counts, `API_Reference_and_Tests.md`).

**User (mid-turn):** "does all the services and local infra works fine?"

Compose healthy, both `/health` returning ok; `local-infra` not running (4569/9324/4010/3000 closed); `ai-server` error-looping every ~10s:
```
[ERROR] [ai-worker] Error polling SQS: Could not connect to the endpoint URL: "http://localhost:9324/"
```
and its compose service had no `environment:` block.

**User:** "fix the bucket names and wire up the ai-server"

**User (interrupt):** "if you need to define the bucket name or vars in tffvar or env..., just pause to tell me do it"

Chose `helpme-avatars-local`, wired the `ai-server` environment, added bucket + S3 endpoint to both Express services, deleted the dead `s3Bucket` read, updated the runbook/README/report. Paused with the one `.env` line for the user.

**User:** pasted `docker compose logs -f ai-server` showing the endpoint had moved to `host.docker.internal:9324` but still failing, plus `Uvicorn running on http://0.0.0.0:8000`.

Found two causes: `serverless-offline-sqs` serves nothing (added the `elasticmq` compose service + `elasticmq.conf`), and the running image was stale (rebuilt with `--build`). Error loop stopped; queues verified via `ListQueues`.

**User (mid-turn):** "what r u doing"

Status: error loop fixed, both causes explained, `.env` and the IPv6-bound S3 still outstanding.

**User:** "what is MinIO"

Explained S3-compatible object storage, what it would look like in compose, and the two caveats (real credentials, duplicate S3 with `local-infra`).

**User:** "fuck dont use it"

Dropped it. Found the real cause: `serverless-s3-local`'s bind option is `address`, not `host`. Set `address: 0.0.0.0`, corrected the SQS plugin endpoint and comments, documented both traps in the runbook.

**User:** "netstat -ano | findstr :4569 — what this for"

Explained Local Address vs interface, ran it (`0.0.0.0:4569`, new PID — user had already restarted), then proved what matters from inside the container: S3, SQS, EventBridge, DynamoDB and Postgres all reachable.

**User:** quoted back the offer to "push a test message through the queue to prove the worker end to end".

Wrote `test/ai-test/pipeline_probe.ts` (enroll → scan → assert match, session, job result; throwaway citizen with no emergency contacts so no alert can be sent). First run exited silently — `finally { process.exit() }` swallowed the error. After adding a `catch`:
```
ABORTED: InvalidAccessKeyId: The AWS Access Key Id you provided does not exist in our records.
```
Confirmed side by side that `S3RVER` works and `test` does not, so every presigned PUT was being refused. Fixed `custom.s3.accessKeyId/secretAccessKey` to `test`; needs a `local-infra` restart to take effect.

**User:** `/commit`

Five commits. Three files carried changes for different groups, so intermediates were staged as blobs with `git hash-object -w --path` + `git update-index --cacheinfo`, leaving the worktree untouched:

```
1eea258 docs: record the header auth bypass and local config traps      (previous session's leftovers)
5718f13 test(report): add the post-confirmation cases as an owner-assigned gap
93b78a7 test(api): assert the deprecated sync face path fails closed
41e9b05 chore(local): give the AI worker a queue, a bucket and reachable endpoints
b18e6e8 docs(claude): add commands and an orientation table
```

The first commit landed with `@` as its subject (PowerShell here-string in the Bash tool) and was amended immediately.

**User:** `/compress`
