# Session: 23-08-2026 01:42 - ai-worker-unblock-privacy-hardening

## Quick Reference
**Topics:** ai worker, SQS, boto3 endpoint_url, ECS task role, security group, RDS connection timeout, face enrolment, avatar_url, presigned URL, S3 copy, scan GPS, access_sessions, complaint suppression, CCCD masking, grant-permission-worker removal, terraform apply, deploy.ps1, bastion
**Projects:** `help_me_backend` — ai-server (Python), read-server, write-server, `infra/` Terraform, `scripts/`
**Outcome:** The deployed face pipeline works end to end for the first time — enrolment writes an embedding and an avatar, a scan matches it. Along the way: two silent production faults fixed, `grant-permission-worker` deleted, GPS captured on every scan method, and CCCD masked from everyone but its owner.

## Decisions Made
- **`LOCAL_AWS_EMULATION` opt-in, real AWS by default** for the AI worker's boto3 endpoints and dummy credentials — beat keeping localhost defaults. A wrong endpoint locally fails on the first poll; a wrong endpoint in cloud fails silently for hours. The failure should point at the loud direction.
- **`avatar_url` stores an S3 key, not a URL** — the bucket blocks all public access, so a stored `https://` object URL would `403` forever. Read paths sign it with `resolveAvatarUrl()`.
- **Enrolment copies the image to `avatars/<citizenId>.jpg`** rather than pointing the avatar at `raw-uploads/`. Beat leaving it in place, which works only until someone adds a lifecycle rule and silently breaks every avatar.
- **Only enrolment sets the avatar**, never a scan — a `raw-scans/` image is a responder's photo of an unconscious stranger.
- **Scan location is nullable and never required** — beat matching `/api/emergency/report`'s `400` on missing coordinates. Blocking a medical record over a GPS permission is the wrong trade on the golden-hour path.
- **Scan location lives on `access_sessions` + the event**, beat event-only (not queryable) and a new `scan_events` table (new writes on the emergency path).
- **Sessions granted for every returned face candidate**, but `victim.identified` fires for the **primary only** — granting is accountability, alerting is a claim about reality, and only one person is actually lying there. Publishing for candidates 2 and 3 would alert two uninvolved families.
- **CCCD masked everywhere except the owner's own profile.** Masking guards one person's identity from another; against the subject it protects nobody and denies them their own data.
- **`grant-permission-worker` deleted, not left as a no-op.** Its own comment claimed it was kept so the EventBridge rule had a live target — but the rule also targets `notification-worker`, so that reason did not hold. A Lambda named "grant-permission" that grants nothing is worse than useless.
- **Terraform for the SG rule, not `aws ec2 authorize-security-group-ingress`** — a hand-made rule leaves state out of sync and the next `terraform apply` fails on `InvalidPermission.Duplicate`.

## Key Learnings
- **The deployed AI worker was polling itself.** `worker.py` defaulted every boto3 `endpoint_url` to a localhost emulator address when its env var was absent, and the Fargate task definition sets no endpoint variables. `AI_JOBS_QUEUE_URL` was correct — the *endpoint* it was sent to was `http://localhost:9324`, inside the task. Symptom: `Available: 1`, `NotVisible: 0`, job stuck `PENDING`, task `RUNNING` and "steady state" throughout.
- **`os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")` ran unconditionally** and overwrote the ECS task role — env vars outrank the container credential provider in boto3's chain. Fixing endpoints alone would only have moved the failure to `InvalidClientTokenId`.
- **The AI task's security group was never allowed into RDS.** `modules/rds` accepted only `app_tasks_sg_id` and `bastion_sg_id`; `modules/ai_service` declared `app_tasks_sg_id` as a variable and **never referenced it**, which made the wiring look present. Dropped packets, not refused: `Connection timed out`.
- **A blocked SG makes `psycopg2` hang ~131s** with no `connect_timeout`, exceeding the queue's 120s `VisibilityTimeout` — the message goes visible again while the worker still holds it. Now `connect_timeout=10`.
- **CloudWatch log groups were missing.** `/ecs/helpme-ai` and `module.ecs.aws_cloudwatch_log_group.services` did not exist in the account (only `/aws/lambda/*` did), so a container error-looping every 5 seconds produced no logs anywhere. Something deletes log groups out of band.
- **Job TTL was shorter than SQS retention** — job records expired after 2h while messages live 24h. The worker then found no `citizen_id` and still wrote `COMPLETED` + `enrolled: true` with nothing written. Enrolment jobs now get a 25h TTL; scans keep 2h because their payload holds a medical record.
- **A zero-row `UPDATE` is "success" in psycopg2** — `cur.rowcount == 0` / `RETURNING` must be checked explicitly, or a wrong `citizen_id` reports enrolment against a citizen that does not exist.
- **The EventBridge rule filters `raw-uploads/` and `raw-scans/` only**, which is what makes the avatar copy safe. A copy into either watched prefix would be processed as a **scan**: phantom job, access session, `victim.identified`, next-of-kin emailed about an incident that never happened.
- **The complaint block is per `(responder, victim)`**, permanent (nothing in the codebase clears `COMPLAINED`; the admin dashboard only lists), and enforced on all five paths. Its one boundary: `responderId` is a Cognito sub, so a new account is a new principal.
- **Masking a field the client can edit is a data-loss risk.** The app loads the profile, fills the form, the user saves — and `********9885` overwrites the real number while `is_verified` stays true because the string is non-empty. Read masking and the write guard must ship together.
- **Presigned URLs outlive the session that produced them.** `resolveAvatarUrl` signs for 1 hour; a complaint blocks the API instantly but cannot revoke an already-issued S3 signature.
- **`i-03edbd7d43f7aa022` in `cloud-start/stop.ps1` did not exist** — `cloud-stop.ps1` had been "stopping" a deleted instance while the real bastion `i-0a17d690227c2fc48` ran continuously since 2026-08-22 03:07 UTC.
- **`!` in the Claude Code prompt runs bash, not PowerShell** — `$env:VAR=$null` is a no-op there, so `.env`'s `AWS_ACCESS_KEY_ID=test` reached Terraform and produced `InvalidClientTokenId` twice. Bash needs `env -u`.
- **PowerShell splits `-target=aws_security_group_rule.x`** unless the whole token is quoted; Terraform then reports `Invalid target "aws_security_group_rule"`.
- **`terraform.tfvars` sets `ai_internal_secret`, which no `variable` block declares** — dead config, matching the docs' note that `AI_INTERNAL_SECRET` / `AI_SERVER_URL` are read by no code.

## Pending Tasks
- [ ] Full `terraform apply` — destroys the 5 `grant-permission-worker` resources and creates `module.ecs.aws_cloudwatch_log_group.services`, which is why read/write server logs are still unreadable. Plan reviewed: `2 to add, 2 to change, 5 to destroy`. Eyeball the unrelated `module.auth.aws_cognito_identity_provider.google` in-place update first.
- [ ] Short TTL for avatar presigned URLs (60–300s) so a revoked access cannot keep serving the photo for an hour. Needs a separate TTL from the shared `getPresignedDownloadUrl`.
- [ ] Decide whether a face scan must always return **two** candidates. Today it returns *up to* 3 — the `< 0.35` threshold filters before `LIMIT`, and a real production scan returned `matchesCount: 1`. Guaranteeing two means moving the threshold out of the `WHERE` and into a confidence label.
- [ ] `scan.routes.ts` sync FACE branch still has the old single-candidate complaint check. Unreachable today (`extractFaceFeature` throws without `AI_LAMBDA_NAME`), but it returns with the path if revived.
- [ ] Non-primary candidates still carry a full medical record. Identity-only until the responder picks one would be tighter.
- [ ] Two enrolment uploads were lost to the DB outage (`79deba69`, `9f40b0b6`) — those citizens must re-upload.
- [ ] `raw-uploads/` and `raw-scans/` have no lifecycle rule; `raw-scans/` holds photos of unconscious people, retained indefinitely.
- [ ] `DATABASE_URL` sits in plaintext in the ECS task definition, readable via `ecs:DescribeTaskDefinition`; RDS `StorageEncrypted: false`.
- [ ] Flutter: the Vietnamese revocation string has the wrong subject — it is *your* access to that person, not their access. Suggested: `Bạn không còn quyền xem hồ sơ của người này sau khi họ khiếu nại. Quét lại cũng không khôi phục được.`

## Project Structure
```
help_me_backend/
├── CLAUDE.md                        — map to the vault; gained the LOCAL_AWS_EMULATION trap, SKIP_AUTH correction, 74-check count
├── build.js                         — esbuild → zip → infra/modules/; grant-permission-worker entry removed (4 entries, 3 dirs)
├── docker-compose.yaml              — local stack; ai-server gained LOCAL_AWS_EMULATION=true
├── prisma/
│   ├── schema.prisma                — AccessSession gained scan_lat / scan_lon (nullable text)
│   └── seed.ts                      — only writer of avatar_url before this session (dicebear URLs)
├── src/
│   ├── functions/                   — audit-worker, notification-worker, post-confirmation
│   │                                  (grant-permission-worker deleted this session)
│   ├── services/
│   │   ├── ai-server/
│   │   │   ├── main.py              — loads FaceProcessor once, then hands off to the SQS loop; no HTTP surface
│   │   │   ├── worker.py            — SQS consumer. Endpoint/credential switch, connect_timeout,
│   │   │   │                          enrolment guards, avatar copy, batched complaint check,
│   │   │   │                          per-candidate grants, mask_cccd
│   │   │   └── requirements.txt     — OpenCV pinned <5 (Caffe importer)
│   │   ├── read-server/routes/
│   │   │   ├── scan.routes.ts       — NFC/QR/FACE + job polling; GPS in, avatar signed, CCCD masked
│   │   │   ├── victim.routes.ts     — re-access behind hasActiveSession; signs + masks
│   │   │   ├── citizen.routes.ts    — own profile: avatar signed, CCCD deliberately NOT masked
│   │   │   ├── admin.routes.ts      — registry + detail; CCCD masked, search still on the real column
│   │   │   └── history.routes.ts    — three strands of citizen activity; victim avatars signed
│   │   ├── read-server/services/session.service.ts  — 12h grant, COMPLAINED terminal, location normalised
│   │   └── write-server/routes/
│   │       ├── upload.routes.ts     — presigned PUT; operation-aware TTL (25h enrol / 2h scan), GPS onto the job
│   │       └── citizen.routes.ts    — profile upsert; ignores a masked cccdNumber
│   └── shared/services/
│       ├── s3.service.ts            — presign PUT/GET + resolveAvatarUrl (key → signed, URL → passthrough)
│       ├── mask.service.ts          — NEW. maskCccd / maskCitizenIdentifiers, idempotent
│       └── job.service.ts           — ScanJobRecord gained scan_lat / scan_lon
├── infra/                           — Terraform. main.tf gained aws_security_group_rule.ai_tasks_to_rds;
│   │                                  rds + ai_service expose security_group_id; lambda/eventbridge lost the grant worker
│   └── modules/sqs/main.tf          — queue (120s visibility, 1-day retention) + the prefix-filtered S3 rule
├── local-infra/serverless.yml       — host-side emulators; grantPermissionWorker entry removed
├── scripts/
│   ├── deploy.ps1                   — build+push ECR / Lambda zips; "grant" mapping removed
│   ├── cloud-start.ps1 / cloud-stop.ps1 — bastion id now from `terraform output`, not a stale literal
│   └── connect_to_rds_through_bastion_host.md — rewritten as a fork-safe runbook (port 5433)
├── test/api-test/                   — 74 in-process checks; WK-07 retired with the grant worker
└── docs/                            — the vault (this log lives in docs/Sessions/)
```

---

## Raw Session Log

**User:** `/init` — analyze the codebase and create a CLAUDE.md.

Found an existing `CLAUDE.md` and audited it against the tree rather than rewriting. Four claims had gone stale: the suite is **75/75**, not 62/63 (the `consentRegulation ?? true` defect was fixed 2026-08-22); the header-auth bullet was **inverted** — `auth.ts:60` now reads `if (SKIP_AUTH && headerId)`. Added the three `npx tsx` checks and `db:studio`/`ddb:admin`. Flagged that `history.routes.ts`, QR unlink, and access revoke had shipped without doc updates, and that `~/.codex/config.toml` + `~/.gemini/GEMINI.md` exist for `/import`.

**User:** does S3 need to set by clickops or what?

No — `modules/s3` owns the avatars bucket including `aws_s3_bucket_notification.avatars_eventbridge`, which is the entry point of the face pipeline. Only exception: the Terraform **state** bucket + lock table, bootstrapped by CLI (`Cloud_Deployment`, "State backend").

**User:** how the flow register avatar work

Walked the async enrolment: `POST /upload-url` → `raw-uploads/{jobId}.jpg` + `PENDING` job → client PUTs → S3 → EventBridge → SQS → `worker.py` (`is_enrollment = "raw-uploads" in key`) → MediaPipe/anti-spoof/EdgeFace → `UPDATE citizens SET face_embedding …` → poll `GET /api/scan/jobs/:jobId`. Flagged that **nothing writes `citizens.avatar_url`** (only `seed.ts:52`) while three read paths return it.

**User:** the ai-service will continuously poll the job in sqs huh?

Yes — long poll, `WaitTimeSeconds=20`, `MaxNumberOfMessages=5`, `VisibilityTimeout=120`, `desired_count = 1`. Flagged concurrency of 1 and that `delete_message` in a `finally` makes the `maxReceiveCount = 3` DLQ nearly unreachable.

**User:** i see 1 message available, and 1 scan job for long long time, what happen

Diagnosed live. `Available: 1 / NotVisible: 0` = nothing ever received it; job `79deba69` `PENDING` = the worker never touched it. Root cause: task def sets no `SQS_ENDPOINT_URL`, so `worker.py:19` fell back to `http://localhost:9324` — the task polling itself. Same for S3/DynamoDB/EventBridge. Invisible because `/ecs/helpme-ai` did not exist. Deadline: 1-day queue retention.

**User:** fuck it, do it right mow → **deploty it**

Added `LOCAL_AWS_EMULATION`; moved the dummy credentials inside it (they were overwriting the task role); startup logs the resolved mode; escalating log at 5/50 consecutive failures. Created `/ecs/helpme-ai`. Deploy blocked by the classifier at first.

**User:** kms for encryption, decruptioon at rest, what do you think?

Audited: S3 `AES256`, DynamoDB AWS-owned key, SQS `SqsManagedSseEnabled`, **RDS `StorageEncrypted: false`**. Argued `storage_encrypted = true` matters more than CMK, cannot be enabled in place, and ranks *below* moving `DATABASE_URL` out of the plaintext task definition.

**User:** hey hey, why the ai dont work → deploy it pls → ah huh u miss some cred to deploy ai server right?

Not credentials — I had already created a log group in the account. The gate was the harness classifier. Task def still `helpme-ai:5`; queue now at 2.

**User:** do the citizen_id fix first, then i deploy

Enrolment now fails honestly: no `citizen_id` → `FAILED`; zero-row `UPDATE` → `rollback()` + `FAILED`. Root cause fixed too — enrolment TTL 7200 → 90000s so a job record outlives its 24h message. Corrected my own earlier claim: the presigned PUT is 3600s, the *comment* saying "15 min" was wrong.

**User:** ok deploy them for me → i replace the null huh → *(pasted PowerShell into bash)*

`bash: :AWS_ACCESS_KEY_ID=: command not found` then `InvalidClientTokenId`. `!` runs bash; `$env:` is PowerShell.

**User:** is the helpme-grant-permission-worker needed here? … does the grant access worker (lambda) needed? → **remove it**

Confirmed retired: 26 lines, one `console.log`, still targeted by `helpme-identification-rule` and still firing. Its stated reason for existing was wrong — the rule also targets `notification-worker`. Removed across Terraform (target, function, IAM role, output, wiring), `build.js`, `deploy.ps1`, the handler dir + checked-in zip, `local-infra/serverless.yml`, WK-07, and six doc pages. `tsc`, `terraform validate` clean; `node build.js` now packages three zips; suite 75 → 74.

**User:** does this ai service qualify the condiftion: ai service will give user two result of 2 most-similar face users?

Up to 3 (`LIMIT 3`, `< 0.35`), so top-2 is included but not guaranteed. Flagged two holes: non-primary candidates carry full medical records with no session, and `is_complained` covers only the primary. Also found docs/code drift — `AI_Server.md` said a 1-hour DynamoDB session; code is **12 hours in Postgres**.

**User:** i want to apply all / i want to deploy all → code for me to deploy

`terraform apply` blocked in both shells. Ran `terraform plan` instead: `2 to add, 2 to change, 5 to destroy`, the five being the grant worker. Noted `module.ecs.aws_cloudwatch_log_group.services` would be *created* — i.e. missing.

**User:** *(pasted the deploy line twice, both failed)* → hey fuck, it dont work

Their log actually showed progress: `16:55:21.403 RESULT: REAL FACE` → `16:55:31.528 timeout expired` = **10.1s**, proving `connect_timeout=10` was live. The SG rule had never been applied — every `terraform apply` died at `InvalidClientTokenId`. Wrote `scripts/fix-ai-db-access.ps1` to remove the shell-syntax trap; first run hit `Invalid target "aws_security_group_rule"` (PowerShell splitting the `-target` token), fixed by quoting.

**User:** *(ran the script)* → `Apply complete! Resources: 1 added` — `sg-047bb2415ef201404` now in the RDS allow-list.

**User:** modify the connect_to_rds_.. to be any one forked my github can use

Rewrote it from one hardcoded line into a runbook reading both identifiers from `terraform output`, with port **5433** (5432 is Docker's Postgres — forwarding onto it silently serves local seed data). Discovered `i-03edbd7d43f7aa022` does not exist; fixed both cloud scripts to resolve the id from Terraform.

**User:** hey hey, does it move that file out off raw-uploads or what? → i dont get what you mean, short please → does this violent the job trigger → **1. ok add copy step / 2. does ai service update the avatar_url if sucessfull?**

Nothing moves it; `worker.py` only calls `get_object`; no lifecycle config; 15 objects / 10.8 MB. The trigger question was sharp — safe only because the rule filters `raw-uploads/` and `raw-scans/` by prefix. Added `copy_avatar_object` → `avatars/<citizenId>.jpg`, `RETURNING id` for the real UUID, avatar written in the same success path.

**User:** ok, deploy it

Deployed. Confirmed live: `avatars/ccea2bec-….jpg` (141 KB) and a job carrying `avatarKey`. Earlier: `COMPLETED ENROLLMENT bcdf81a5` and `FACE_SCAN 89fdf4a6 → MATCH_FOUND, distance 0.3106` — first working end-to-end run.

**User:** 1. i want when scanning by qr, nfc, face scanning, it should cover the gps as well

Asked two questions (storage location; behaviour on no fix) — both answered with the recommended option. Added `scan_lat`/`scan_lon` to `AccessSession`, accepted `lat`/`lon` or `latitude`/`longitude`, carried face GPS through the job record, validated range, and used conditional-omit / `COALESCE` so a fix-less rescan cannot erase a known location.

**User:** give me code to edit directly → **2. deploy… please** → i already run the alter table

Supplied the idempotent `ALTER TABLE` and the ordering rule: migration first, or Prisma's select-all breaks every `access_sessions` read.

**User:** hey hey user when scanning does not seee user's avatar

Avatar existed; only `/api/citizen/profile` signed it. Signed it on five more paths, including `GET /api/scan/jobs/:jobId` — the one the app actually polls after a face scan.

**User:** hey is it right: `Quyền truy cập của người này đã bị thu hồi vĩnh viễn và không thể quét lại` → does backend qualify that

"Permanent" is accurate; the *subject* is wrong — it is the responder's access to that person. Confirmed enforcement on all five paths plus `grantAccessSession` itself.

**User:** u remember the question I asked once … → **check for all please / grant access for all**

Batched complaint query on the open cursor (replacing `is_complained`), suppressed candidates dropped before their record is fetched, `ACCESS_REVOKED` when all are suppressed, `suppressedCount` reported, a session per returned candidate, and `victim.identified` deliberately left primary-only.

**User:** make the backend when scannning just show some last number in the cccd-number → **apply it in every featuyres that have return cccd_number**

Added `mask.service.ts` (`********9885`, idempotent) plus a Python mirror, applied to scan, job polling, victim re-access, admin registry + detail, own profile, and the worker's DynamoDB write. Added the write guard that treats any `*`-bearing `cccdNumber` as unchanged.

**User:** deploy → how about I view my self's cccd → **yeah** *(unmask own profile)*

Unmasked both own-profile paths, kept the guard, deployed `read` + `write`. Verified the AI service was healthy, not stuck: steady state 01:04:54, new deployment 01:07:33, old task stopped 01:10:27.

**User:** `/commit`

Most of the session was already committed (`153ff4f`, `152ace3`). Two new commits: `e7f533a` (CCCD masking) and `6e8684d` (per-candidate complaints + masked job results). `worker.py` genuinely served both groups; kept whole and named both concerns in the subject rather than hiding one.
