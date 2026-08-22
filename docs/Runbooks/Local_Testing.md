# Local Testing & Development Runbook

Run and test the entire HelpMe backend locally with zero cloud costs using Docker and Serverless Framework offline plugins.

---

## 🛠️ Step 1: Database Setup

Start local PostgreSQL 16 with `pgvector` enabled, plus DynamoDB Local and its table setup:

```bash
docker compose up -d db dynamodb dynamodb-init
npm run prisma:generate
npm run db:push
npm run db:seed
```

`db` is Postgres 16 + pgvector on `:5432`. `dynamodb` is DynamoDB Local on `:8001` (volume-backed,
so tables survive restarts) and `dynamodb-init` creates `helpme-access-sessions`,
`helpme-scan-jobs` and `helpme-audit-logs`, then exits — it is idempotent and safe to re-run.

---

## 🌐 Step 2: Start Local AWS Emulators (`local-infra/`)

The `local-infra/` suite emulates AWS cloud resources without LocalStack fees:

```bash
cd local-infra
npx serverless offline start
```

| Service | Provided by | Port |
|---|---|---|
| **S3 Avatars Bucket** | `serverless-s3-local` | `http://localhost:4569` |
| **DynamoDB (Jobs & Sessions)** | `serverless-dynamodb` | `http://localhost:8001` |
| **SQS AI Jobs Queue** | **`elasticmq` compose service** — not this stack | `http://localhost:9324` |
| **EventBridge Bus** | `serverless-offline-aws-eventbridge` | `http://localhost:4010` |
| **Lambda Handlers** | `serverless-offline` | `http://localhost:3000` |

> ⚠️ **`serverless-offline-sqs` is a client, not a server.** Its own README: "there should be some
> queue system actually running." Nothing here ran one, so `:9324` had no listener and the AI
> worker error-looped on `Could not connect to the endpoint URL`. The queue now comes from
> `docker compose up -d elasticmq`, configured by `local-infra/elasticmq.conf`, which declares
> `helpme-ai-jobs-queue` and its DLQ up front. Start it whether or not you run this stack.

> ⚠️ **The S3 bind option is `address`, not `host`.** `serverless-s3-local` defaults `address` to
> `localhost`, which resolves to `::1` on Windows — the server then answers only on IPv6 loopback
> and is unreachable from any container through `host.docker.internal`. `custom.s3.address` is now
> `0.0.0.0`; `host` is a different setting (where the plugin makes its own internal calls) and
> binds nothing. Restart the stack for it to take effect.

> ⚠️ **The local S3 credentials must be `S3RVER`/`S3RVER`, not `test`/`test`.**
> `serverless-s3-local` wraps `s3rver`, which registers exactly one key pair at module load
> (`lib/models/account.js`: `DUMMY_ACCOUNT.createKeyPair('S3RVER', 'S3RVER')`) and answers every
> other key with `403 InvalidAccessKeyId` — at `lib/middleware/authentication.js:163`, *before* it
> looks at the signature, so `allowMismatchedSignatures: true` does not help either.
> Setting `custom.s3.accessKeyId` does **not** change this: `serverless-s3-local/index.js:273`
> never passes those options to `new S3rver({...})` — they only feed the plugin's own internal
> client at `index.js:362`. The clients had to change instead:
> `s3.service.ts:17`, `docker-compose.yaml` (`ai-server`) and `test/ai-test/pipeline_probe.ts`
> all sign with `S3RVER` now. Production is unaffected — it leaves the endpoint unset, so
> credentials stay `undefined` and the AWS provider chain supplies the real role.

> ⚠️ **`vhostBuckets` must be `false`, or containers get `NoSuchBucket`.**
> `s3rver` defaults it to `true`, and its vhost middleware then treats any hostname that is not an
> IP and not `localhost` as a bucket name (`lib/middleware/vhost.js:33-41`), rewriting the path to
> `/<hostname>/<path>`. A worker calling `host.docker.internal:4569` therefore asks for bucket
> `host.docker.internal` and gets `NoSuchBucket`, while the same request from the host over
> `127.0.0.1` succeeds — an IP is exempt. `custom.s3.vhostBuckets: false` restores path-style.

### Pointing the app at the emulators

Each emulator listens on its **own** port, so a single generic endpoint cannot serve all of them.
`.env` must set one variable per service:

```bash
EVENTBRIDGE_ENDPOINT="http://localhost:4010"
S3_ENDPOINT="http://localhost:4569"
DYNAMODB_ENDPOINT="http://localhost:8001"
```

> **Do not set `AWS_ENDPOINT_URL=http://localhost:4566`.** `:4566` is LocalStack's port, and this
> project does not use LocalStack. Any client falling back to it fails with `ECONNREFUSED` — and
> because event publishing is best-effort, the failure is logged but never changes an HTTP status,
> so tests still pass while the whole event path is silently dead.
>
> `AWS_ENDPOINT_URL` remains supported as a fallback for all three services (and is what production
> leaves unset), but the per-service variables take precedence.

### ⚠️ Editing `.env` mid-session has no effect

`dotenv.config()` does **not** overwrite a variable that is already present in `process.env`. Any
shell that inherited `.env` at start-up keeps the old values for its whole lifetime, so an edit can
look like it did nothing — for example a `ResourceNotFoundException` naming a DynamoDB table that
demonstrably exists. Either restart the shell, or override for one command:

```bash
env -u ACCESS_SESSIONS_TABLE -u AWS_ENDPOINT_URL npm run test:api
```

### 🪣 One local bucket name: `helpme-avatars-local`

Every local surface signs and serves the same bucket:

| Where | Value |
| :-- | :-- |
| `s3.service.ts:11` (default when `AWS_S3_BUCKET` is unset) | `helpme-avatars-local` |
| `local-infra/serverless.yml` → `custom.s3.buckets` | `helpme-avatars-local` |
| `docker-compose.yaml` → write-server, read-server, ai-server | `helpme-avatars-local` |
| **`.env` → `AWS_S3_BUCKET`** | **must be set to `helpme-avatars-local`** |

`.env` is the one file that is not in git, so it is the one you have to keep in step: a stale
`AWS_S3_BUCKET=helpme-avatars-bucket` signs URLs for a bucket the emulator does not have, and the
`PUT` fails while `POST /api/upload-url` still returns a healthy `200`.

The old third name is gone: `upload.routes.ts` used to read `S3_AVATARS_BUCKET_NAME` into a
variable it never used. Production is unaffected either way — Terraform generates the real bucket
(`infra/modules/s3/main.tf`: `${project_name}-avatars-${random_suffix}`) and injects it as
`AWS_S3_BUCKET` into the ECS task definitions.

### Table names

`serverless.yml` provisions `helpme-scan-jobs`, `helpme-access-sessions` and `helpme-audit-logs`.
Override them only with names that actually exist, and note that the audit worker reads
**`AUDIT_TABLE_NAME`** — `AUDIT_LOGS_TABLE` is a leftover from the retired ECS stack and is read by
nothing in `src/`. Unlike `SCAN_JOBS_TABLE`, which `job.service.ts` defaults to `helpme-scan-jobs`,
the audit worker has no fallback: without `AUDIT_TABLE_NAME` it logs
`[audit] AUDIT_TABLE_NAME not set` and drops every event, so the whole audit trail goes missing
while every HTTP status stays green.

---

## 🚀 Step 3: Start Microservices

Open three separate terminals:

### Terminal 1: Write Server (`:8080`)
```bash
npm run dev:write
```

### Terminal 2: Read Server (`:8081`)
```bash
npm run start:read
```
(There is no `dev:read` script — only the write server has a watch mode, `npm run dev:write`.)

### Or: run both servers in Docker
```bash
docker compose up -d --build write-server read-server
```
Their Dockerfiles copy `prisma/` and run `prisma generate` during the build. If you strip that out,
the image starts and immediately dies with
`@prisma/client did not initialize yet` — note that `npm run build:server` is `tsc` alone, whereas
`npm run build` is `prisma generate && tsc && node build.js`.

Containers do **not** receive `SKIP_AUTH`, so they enforce real authentication and reject header
auth: expect `401` where the in-process test suite returns `404`.

### Terminal 3: AI Service & SQS Background Worker
```bash
cd src/services/ai-server
pip install -r requirements.txt
python main.py
```

`docker compose up -d ai-server` now runs the same worker with its endpoints wired (see
[[Services/AI_Server]]): SQS, S3 and EventBridge come from the **host** stack of Step 2 via
`host.docker.internal`, DynamoDB and Postgres from the compose network. Start `local-infra` first
or the worker error-loops on `Could not connect to the endpoint URL`.

`main.py` is an **SQS consumer with no HTTP surface** — it serves the async S3 → SQS pipeline only.
It does not back `POST /api/citizen/face` or `POST /api/scan { method: "FACE" }`: those go through
`shared/services/ai.service.ts`, which invokes an AI Lambda named by `AI_LAMBDA_NAME` and throws
`Synchronous face extraction endpoint is deprecated` when that is unset — which it is, everywhere.
Starting this worker therefore unblocks no API check; see §13 of `test/api-test/README.md`.

---

## 🧪 Step 4: Run the API Test Suite

```bash
npm run test:api
```

Builds the read/write routers in-process on ephemeral ports and runs **63 checks** against the
local Postgres. Every run overwrites `docs/Testing/Test_Report.md` with the outcome. It needs the
database (Step 1). Seventeen of those checks (`upload-url`, scan-job polling, the four
victim-access cases, five worker-effect cases and all six async-job cases) additionally need
DynamoDB on `:8001`. The full Step 2 serverless stack provides it, but compose is lighter and
enough:

```bash
docker compose up -d dynamodb dynamodb-init
```

`dynamodb-init` creates the three tables and exits; it is idempotent, so it is safe to leave in
every `up`. Skip this and those checks fail with `ECONNREFUSED 127.0.0.1:8001` — and note that the
victim-access case V-01 would still *pass*, because `hasActiveSession()` denies on any DynamoDB
error.

The EventBridge emulator (`:4010`) is only needed if you want the event path to reach the real
workers *in the background*. The tests supply their own sinks instead:

| Sink | Port | Used by | Why |
| :-- | :-- | :-- | :-- |
| `test/api-test/event_capture.ts` | `4610` | §9 | repoints `EVENTBRIDGE_ENDPOINT`, so no emulator is needed and nothing collides with `:4010` |
| `test/api-test/smtp_capture.ts` | `2525` | §10 | `.env` points `SMTP_HOST` at a real provider; no automated run may send real mail |

That is why `[events] failed to publish` warnings no longer appear during `npm run test:api`. Both
sinks must be wired **before** the modules they redirect are imported — `events.service.ts`, the
workers and `s3.service.ts` all bind endpoint, table and SMTP config into module-level constants at
import time. `event_capture.ts` is therefore the first import in `index.ts`, and the §10 group uses
dynamic `await import()`.

To send a real alert on purpose, use `npm run test:notify -- <address>` (see below).

One check fails by design: `R-03` reproduces an open consent defect — see
`test/api-test/README.md` note F. The four `F-*` checks need nothing beyond Postgres: they assert
that the deprecated synchronous face path fails closed (500, no write, no event).

The full catalogue of expected status codes per endpoint is `test/api-test/README.md`.

### Sending a real emergency alert

The automated run never touches the configured SMTP — the worker checks point it at an in-process
sink first. To exercise the real transport, use the opt-in script:

```bash
npm run test:notify -- you@example.com
```

It verifies the credentials in `.env`, sends one genuine "HelpMe Emergency Alert" through
`notification-worker`, and cleans up the throwaway citizen it created. It refuses to run without
an explicit recipient.

---

## 🧬 Step 5: Run AI Biometric Extraction & Matching Test

Test the AI biometric pipeline (MediaPipe $\rightarrow$ Anti-Spoof $\rightarrow$ EdgeFace) with real face images:

```bash
# 1. Place test face photos in: test/ai-test/test-images/input/

# 2. Extract 512-d embeddings to local database-temp.json:
npm run test:ai
# or
python test/ai-test/process_images_to_json.py

# 3. Match a query face photo and retrieve the Top 3 best matches + avatars:
python test/ai-test/process_images_to_json.py --search "test/ai-test/test-images/input/plain-avatar.jpg"
```

> ⚠️ **Only `plain-avatar.jpg` passes the liveness gate.** Every large `.png` in
> `test-images/input/` is a screen capture, and MiniFASNetV2 scores all of them FAKE
> (`good.png` 0.75, `so-far.png` 0.93, `fake-face.png` 0.99) — a photo of a screen is exactly the
> presentation attack it is trained to reject, so this is the model working, not a bug. The `good`
> in `good.png` refers to framing, not liveness. `plain-avatar.jpg` is a real photograph and scores
> REAL 1.00, which makes it the only usable happy-path fixture.

---

## 🔄 Step 6: Prove the whole async pipeline (`test:pipeline`)

The API suite never touches S3, SQS or the worker, so it stays green while the entire asynchronous
face path is dead. Two probes cover what it cannot:

```bash
npm run test:pipeline          # S3 -> SQS -> worker -> pgvector -> DynamoDB -> access session
npx tsx test/ai-test/presign_check.ts   # the presigned PUT the Flutter app actually uses
```

`test:pipeline` enqueues an enrollment job and a scan job by hand and asserts all seven outcomes:
the job reaches `COMPLETED`, the 512-d embedding lands in Postgres, `is_verified` flips, the scan
reports `MATCH_FOUND` against the enrolled citizen, and the worker grants the 1-hour access session.
It needs the **db**, **dynamodb**, **elasticmq** and **ai-server** compose services plus the
`local-infra` stack for S3.

`presign_check.ts` covers the leg `test:pipeline` bypasses: the write-server issues a presigned URL
through `s3.service.ts` and the client `PUT`s straight to S3. Nothing else exercises it, and it was
broken for the entire life of the local stack (see the `S3RVER` warning in Step 2).

> There is **no S3 → SQS notification rule** in `local-infra`, so nothing enqueues a job when a file
> is uploaded. Both probes post their own SQS message, which is why they work; a manual upload alone
> will sit in the bucket untouched.
