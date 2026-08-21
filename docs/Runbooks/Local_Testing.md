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

| Service | Emulator Plugin | Port |
|---|---|---|
| **S3 Avatars Bucket** | `serverless-s3-local` | `http://localhost:4569` |
| **DynamoDB (Jobs & Sessions)** | `serverless-dynamodb` | `http://localhost:8001` |
| **SQS AI Jobs Queue** | `serverless-offline-sqs` | `http://localhost:9324` |
| **EventBridge Bus** | `serverless-offline-aws-eventbridge` | `http://localhost:4010` |
| **Lambda Handlers** | `serverless-offline` | `http://localhost:3000` |

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

### Table names

`serverless.yml` provisions `helpme-scan-jobs`, `helpme-access-sessions` and `helpme-audit-logs`.
Override them only with names that actually exist, and note that the audit worker reads
**`AUDIT_TABLE_NAME`** — `AUDIT_LOGS_TABLE` is a leftover from the retired ECS stack and is read by
nothing in `src/`.

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

---

## 🧪 Step 4: Run the API Test Suite

```bash
npm run test:api
```

Builds the read/write routers in-process on ephemeral ports and runs **46 checks** against the
local Postgres. Every run overwrites `docs/Testing/Test_Report.md` with the outcome. It needs the database (Step 1). Seven of those checks (`upload-url`, scan-job
polling and the four victim-access cases) additionally need DynamoDB on `:8001`. The full Step 2
serverless stack provides it, but compose is lighter and enough:

```bash
docker compose up -d dynamodb dynamodb-init
```

`dynamodb-init` creates the three tables and exits; it is idempotent, so it is safe to leave in
every `up`. Skip this and those checks fail with `ECONNREFUSED 127.0.0.1:8001` — and note that the
victim-access case V-01 would still *pass*, because `hasActiveSession()` denies on any DynamoDB
error.

The EventBridge emulator (`:4010`) is only needed if you want the event path to reach the real
workers. The seven §9 checks do not use it: `test/api-test/event_capture.ts` stands up its own sink
on `:4610` and repoints `EVENTBRIDGE_ENDPOINT` at it for the duration of the run, which is why the
`[events] failed to publish` warnings no longer appear during `npm run test:api`.

One check fails by design: `R-03` reproduces an open consent defect — see
`test/api-test/README.md` note F.

The full catalogue of expected status codes per endpoint is `test/api-test/README.md`.

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
python test/ai-test/process_images_to_json.py --search "test/ai-test/test-images/input/good.png"
```
