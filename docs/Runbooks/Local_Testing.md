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

## 🧪 Step 4: Run AI Biometric Extraction & Matching Test

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
