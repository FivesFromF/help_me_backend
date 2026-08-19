# 🧪 HelpMe Local Infrastructure

Free, zero-cost local AWS infrastructure emulators using **Serverless Framework offline plugins** — no LocalStack subscription needed.

---

## 📂 Folder Structure

```
local-infra/
├── serverless.yml               # Boots all local emulators
└── package.json                 # Plugin dependencies

test/
└── test-pipeline.ts             # Full end-to-end integration test suite
```

---

## 🔌 What Each Plugin Emulates

| Plugin | Emulates | Port |
|---|---|---|
| `serverless-offline` | Lambda HTTP invocations | `:3000` |
| `serverless-s3-local` | Amazon S3 (stores files in `.local-s3/`) | `:4569` |
| `serverless-dynamodb` | Amazon DynamoDB (in-memory) | `:8001` |
| `serverless-offline-sqs` | Amazon SQS via ElasticMQ | `:9324` |
| `serverless-offline-eventBridge` | Amazon EventBridge routing | `:4010` |

---

## 🏗️ Full Local Test Architecture

```
[ test-pipeline.ts ]
      │
      ├─ 1. PUT dummy image ──────────────► [ S3 Local :4569 ]
      │                                              │
      │                                   (S3 event simulated)
      │                                              │
      ├─ 2. SendMessage ─────────────────► [ SQS Local :9324 ]
      │                                              │
      │                               serverless-offline-sqs
      │                                              │
      │                                              ▼
      │                               [ aiJobConsumerTest Lambda ]
      │                                  (logs message shape)
      │
      ├─ 3. PutEvents ───────────────────► [ EventBridge Local :4010 ]
      │      (victim.identified)                     │
      │                           serverless-offline-eventBridge
      │                                              │
      │                   ┌──────────────────────────┤
      │                   ▼                          ▼                    ▼
      │         [ auditWorker ]        [ grantPermissionWorker ]  [ notificationWorker ]
      │         (writes AuditLogs      (writes AccessSessions       (sends email via
      │          to DynamoDB)           to DynamoDB)                 local SMTP :1025)
      │
      ├─ 4. PutItem ─────────────────────► [ DynamoDB Local :8001 ]
      │      (PENDING job)                           │
      │                                              │
      └─ 5. GET /scan/jobs/:id ──────────► [ Read Server :8081 ]
             (polls job status)
```

---

## 🚀 Quick Start

### Step 1: Install plugins
```bash
cd local-test
npm install --legacy-peer-deps
```

### Step 2: Start all local emulators (keep this terminal open)
```bash
cd local-test
npx serverless offline start
```

### Step 3: Start your backend services (separate terminals)
```bash
# Terminal 1
npm run dev:write

# Terminal 2
npm run dev:read

# Terminal 3
cd src/services/ai-server && python main.py
```

### Step 4: Run the full integration test
```bash
# From the project root
npm run test:local
```

---

## 📧 Local Email Testing (MailHog)

Run MailHog to capture emails sent by `notification-worker`:

```bash
docker run -d -p 1025:1025 -p 8025:8025 mailhog/mailhog
```

Then view captured emails at **http://localhost:8025**

---

## 🐍 Testing the Python AI Worker with Local SQS

The Python AI worker (`src/services/ai-server/worker.py`) reads from SQS.
Set these env vars before running `python main.py`:

```bash
$env:AWS_ENDPOINT_URL = "http://localhost:9324"  # SQS
$env:AI_JOBS_QUEUE_URL = "http://localhost:9324/queue/helpme-ai-jobs-queue"
$env:SCAN_JOBS_TABLE = "helpme-scan-jobs"
$env:ACCESS_SESSIONS_TABLE = "helpme-access-sessions"
$env:AWS_REGION = "ap-southeast-1"
$env:AWS_ACCESS_KEY_ID = "test"
$env:AWS_SECRET_ACCESS_KEY = "test"
```