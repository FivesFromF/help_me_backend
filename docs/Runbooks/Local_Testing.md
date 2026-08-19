# Local Testing & Development Runbook

Run and test the entire HelpMe backend locally with zero cloud costs using Docker and Serverless Framework offline plugins.

---

## 🛠️ Step 1: Database Setup

Start local PostgreSQL 16 with `pgvector` enabled:

```bash
docker compose up db -d
npm run prisma:generate
npm run db:push
npm run db:seed
```

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

---

## 🚀 Step 3: Start Microservices

Open three separate terminals:

### Terminal 1: Write Server (`:8080`)
```bash
npm run dev:write
```

### Terminal 2: Read Server (`:8081`)
```bash
npm run dev:read
```

### Terminal 3: AI Service & SQS Background Worker
```bash
cd src/services/ai-server
pip install -r requirements.txt
python main.py
```

---

## 🧪 Step 4: Run Automated End-to-End Test Suite

Run the full integration test suite from the root directory:

```bash
npm test
# or
npm run test:local
```

### Test Coverage:
1. **Health Checks**: Write (`:8080`) and Read (`:8081`) servers.
2. **S3 Presigned Upload**: Upload dummy face scan to local S3.
3. **SQS Event Dispatch**: Publish `ObjectCreated` message to `helpme-ai-jobs-queue`.
4. **DynamoDB State**: Create and read back `PENDING` scan jobs.
5. **EventBridge Routing**: Dispatch `victim.identified` event to `helpme-emergency-bus`.
6. **Worker Side-Effects**: Verify `grantPermissionWorker` creates a 1-hour session.
7. **Read Server Polling**: Query `GET /api/v1/read/scan/jobs/:jobId` via Express middleware.

