# Session: 23-08-2026 01:42 - ai-worker-unblock-privacy-hardening

## Quick Reference
**Topics:** ai worker, SQS, boto3 endpoint_url, ECS task role, security group, RDS connection timeout, face enrolment, avatar_url, presigned URL, S3 copy, scan GPS, access_sessions, complaint suppression, CCCD masking, grant-permission-worker removal, terraform apply, deploy.ps1, bastion, KMS, RDS encryption at rest, snapshot copy migration, terraform state rm/import, DbiResourceId, inline vs standalone security group rules, aws/rds managed key, service scope regional global zonal, data residency
**Projects:** `help_me_backend` — ai-server (Python), read-server, write-server, `infra/` Terraform, `scripts/`
**Outcome:** The deployed face pipeline works end to end for the first time — enrolment writes an embedding and an avatar, a scan matches it. Along the way: two silent production faults fixed, `grant-permission-worker` deleted, GPS captured on every scan method, and CCCD masked from everyone but its owner. Then RDS was migrated to encryption at rest with the AWS-managed `aws/rds` key, on the same endpoint, with no application change — and two Terraform state hazards found in the process.

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
- **AWS-managed `aws/rds` key, not a CMK**, for RDS encryption. Beat a customer-managed key: same encryption, same compliance position, no cost, and impossible to lose — disabling or deleting a CMK makes the database and every snapshot permanently unreadable. Given up: an auditable key policy and the ability to revoke, which is the argument for a CMK if biometrics ever need it under PDPD.
- **Guard the Terraform before touching AWS.** `storage_encrypted = true` + `prevent_destroy` + `skip_final_snapshot = false` were committed *first*, so the destructive plan errored instead of running. Beat migrating first and editing config after, which leaves a window where any `apply` destroys the database.
- **Rename the restored instance rather than repointing `DATABASE_URL`** — reproduces the identical endpoint hostname, so no task definition, `.env`, or redeploy changes. Beat accepting the new endpoint and editing it in five places.
- **Every rule on the RDS security group is a standalone `aws_security_group_rule`.** Beat keeping inline `ingress` blocks: inline is treated as the complete set, so it deletes the AI worker's rule on every apply. The AI rule cannot move inline without creating an `rds` ↔ `ai_service` module cycle.
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
- **`aws_db_instance` is keyed in Terraform state by `DbiResourceId`, not by identifier.** After the rename swap, state still pointed at the old plaintext instance (`db-C6LNNKDVS5ODXIGCPOQR56TU64`) and planned `storage_encrypted = false -> true # forces replacement`. `prevent_destroy` caught it. Fix: `terraform state rm` then `terraform import <addr> helpme-db` — import takes the *identifier*.
- **Inline and standalone security-group rules cannot coexist.** An inline `ingress` block is the complete rule set, so Terraform deletes anything declared elsewhere. Converting requires `terraform import` of the existing rules (`<sg-id>_<type>_<protocol>_<from>_<to>_<source>`, `all` for `-1`), because a plain apply hits `InvalidPermission.Duplicate`.
- **`copy-db-snapshot --kms-key-id` is the only step that can introduce encryption.** You cannot encrypt an instance or a snapshot in place; the copy reads plaintext and writes ciphertext, and everything restored from it inherits.
- **A restore inherits almost nothing about placement.** `--multi-az`, `--vpc-security-group-ids`, `--db-subnet-group-name`, `--no-publicly-accessible` must all be passed again. Omit `--multi-az` and you silently get a single-AZ database that looks correct in every other respect. Tags and `backup_retention_period` did carry over.
- **Encryption is not retroactive, and manual snapshots never expire.** Automated snapshots taken before the migration stay unencrypted until retention lapses or their instance is deleted; a *manual* snapshot survives instance deletion and bills until explicitly removed. The pre-migration manual snapshot is a plaintext copy of medical records.
- **The behavioural proof of encryption is a later automated snapshot coming out `Encrypted: true`** with no `--kms-key-id` passed. The API flag is authoritative regardless — encryption is a property of the underlying volumes, fixed at creation, which is exactly why it cannot be toggled in place.
- **The `aws/rds` key is created by AWS, not by this stack.** `KeyManager: AWS`, `alias/aws/rds`, no `aws_kms_key` resource anywhere in `infra/`. It is free, undeletable, and shared by everything in the account/region using default RDS encryption. KMS keys are **regional**, so a cross-region snapshot copy for DR cannot use it.
- **No Lambda in this stack has `vpc_config`, deliberately.** `audit-worker` (DynamoDB), `notification-worker` (SMTP) and `post-confirmation` (Cognito) all reach regional public endpoints; a VPC-attached Lambda loses default egress and needs a NAT gateway (~$32/month). This is why `victim.identified` carries `fullName` and `emergencyContacts` inline — so the notifier never queries Postgres.
- **S3 bucket *names* are global, data is regional.** `helpme-avatars-mndkh` and `helpme-terraform-state-xyz` carry suffixes because the namespace is worldwide — a fork cannot reuse them. Both buckets are in `ap-southeast-1`, i.e. Singapore: Vietnamese citizens' biometric and health data is stored outside Vietnam, which PDPD Decree 13/2023 treats as a cross-border transfer.
- **`aws rds wait` dies on a dropped connection** (`Connection was closed before we received a valid response`). An `until` loop of short `describe-db-instances` calls survives it; each iteration is a fresh request.
- **MSYS path conversion mangles CLI arguments in Git Bash** — `/ecs/helpme-ai` became a Windows path (`failed to satisfy constraint: [\.\-_/#A-Za-z0-9]+`), and CIDR strings in import ids need quoting. `MSYS_NO_PATHCONV=1` fixes it.
- **`terraform.tfvars` sets `ai_internal_secret`, which no `variable` block declares** — dead config, matching the docs' note that `AI_INTERNAL_SECRET` / `AI_SERVER_URL` are read by no code.

## Pending Tasks
- [x] ~~Full `terraform apply`~~ — done. `helpme-grant-permission-worker` returns `Function not found`, and both `/ecs/helpme-ai` and `/ecs/helpme-services` exist, so read/write server logs are readable again.
- [ ] Apply the remaining plan: `0 to add, 5 to change, 0 to destroy` — RDS in-place drift plus three security-group-rule descriptions. The fifth, `module.auth.aws_cognito_identity_provider.google`, is unrelated drift that re-pushes the Google IdP config from `terraform.tfvars`; read that diff before approving, it touches sign-in.
- [ ] **Run one face scan to prove `face_embedding` survived the snapshot/restore.** Everything verified so far shows the *instance* is healthy, not the *data*.
- [ ] Delete the manual snapshot `helpme-db-enc` once that scan passes — it is encrypted, so not a privacy issue, but manual snapshots never expire and bill until removed. It is currently the only restore point that does not depend on a live instance.
- [ ] Commit `infra/modules/rds/main.tf` (encryption, `prevent_destroy`, inline→standalone SG rules) and the `Cloud_Deployment.md` runbook section. The SG conversion deserves its own commit with the reason spelled out.
- [ ] Consider `rds.force_ssl = 1` in a custom parameter group — the instance is on `default.postgres16`, which does not force TLS. At-rest and in-transit are separate controls.
- [ ] Data residency: both S3 buckets and RDS are in `ap-southeast-1` (Singapore). For a Vietnamese health system this is a PDPD cross-border transfer question with no AWS-region answer.
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

**User:** give me how you do the kms

Audited what was already encrypted (S3 `AES256`, DynamoDB AWS-owned, SQS `SqsManagedSseEnabled`) and found RDS `StorageEncrypted: false` — the only store holding medical records, CCCD and embeddings. Ranked Secrets Manager for `DATABASE_URL` above it, since the DB password is readable via `ecs:DescribeTaskDefinition`.

**User:** i want to enable kms-based encryption on rds only → *(chose the AWS-managed key)*

Set `storage_encrypted = true`, `skip_final_snapshot = false`, `lifecycle { prevent_destroy = true }`. Verified the guard fires:

```
# module.rds.aws_db_instance.main must be replaced
Error: Instance cannot be destroyed
```

**User:** does it change code? → **teach me 1**

No `src/` change — encryption is below the storage layer. Walked the migration phase by phase.

**User:** *(ran the copy in bash with PowerShell backticks)* `bash: --source-db-snapshot-identifier: command not found`

Backticks are command substitution in bash; supplied one-line and `\`-continued forms.

**User:** *(copy + restore output)*

`Encrypted: true` on `helpme-db-enc`; restore created `helpme-db-new` with `StorageEncrypted: true`, correct SG and subnet group. **Caught that the ECS services were still `1/1`** — Phase 0 had been skipped, so the DB was live and taking writes after the 19:13:02Z snapshot. S3 showed nothing newer than 18:34:40Z, so no enrolment or scan was lost.

**User:** *(`aws rds wait` failed)* `Connection was closed before we received a valid response from endpoint URL`

Client-side connection drop, not a migration failure. Replaced the waiter with an `until` loop of short requests.

**User:** *(swap completed)* `True  arn:aws:kms:...  helpme-db.choikiwi4kk6...  True`

Confirmed at the physical level: `helpme-db` = `db-VBIA2I7O24L3R5BRK5ZDV75ZDE` (encrypted), `helpme-db-old` = `db-C6LNNKDVS5ODXIGCPOQR56TU64` (plaintext).

**User:** *(targeted plan)* `storage_encrypted = false -> true # forces replacement` … `Error: Instance cannot be destroyed`

**Corrected my own earlier claim.** State is keyed by `DbiResourceId`, not identifier, so it still pointed at the old instance. `state rm` + `import helpme-db` fixed it; the remaining diff became in-place drift. Also spotted the plan queuing a **delete of `ai_tasks_to_rds`** — the inline-vs-standalone conflict I had introduced. Converted the RDS group's inline rules to standalone resources; plan went to `3 to add, 1 to change, 0 to destroy`, then the three were imported.

**User:** what next → how to check that it is real encryption enable

Verified three ways: API flag (authoritative — encryption is a volume property fixed at creation), KMS key identity (`KeyManager: AWS`, `alias/aws/rds`, `Enabled`), and behavioural proof — `rds:helpme-db-new-2026-08-23-05-24` came out `Encrypted: True` unprompted. Flagged three pre-migration automated snapshots still `Encrypted: False`.

**User:** do we need delete manual snap shots? → does the current db is multi=az → that key you create by your own huh?

Manual snapshots never expire, unlike automated ones. `helpme-db-preenc` was already deleted, `helpme-db-old` was `deleting`. Multi-AZ confirmed `ap-southeast-1a` / `1b`. The KMS key was **not** created by us — `KeyManager: AWS`, and `grep` found no `aws_kms_key` resource in `infra/`.

**User:** the lambda is no vpc config huh? → so they are reiongale, arent they? → dynamodb?, kms, ecr, eventbridge... what scoe are they → s3 aslso

No Lambda has `vpc_config`, deliberately. Mapped service scopes: global (IAM, CloudFront, S3 bucket names), regional (DynamoDB, KMS, ECR, EventBridge, SQS, Lambda, ECS, Cognito, S3 data), zonal (RDS instance, bastion, subnets). Flagged the KMS-is-regional DR trap and Singapore data residency under PDPD.

**User:** s3 upload images --> lambda --> sqs --> ecs ai task right?

Corrected: there is **no Lambda** in that path. `S3 → EventBridge (prefix-filtered rule) → SQS → ECS Fargate`. Lambdas consume the events the worker *emits* afterwards.

**User:** give me the full flow u have done to apply kms to enable encryption on db

Wrote the ten-phase flow and **fixed the runbook**, which still carried my wrong claim that state survives the rename.
