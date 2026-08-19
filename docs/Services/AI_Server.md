# AI Service (Biometric Worker)

- **Runtime**: Python 3.12+ / PyTorch / MediaPipe / Boto3 / Psycopg2
- **Entry Point**: `src/services/ai-server/main.py`
- **Worker Logic**: `src/services/ai-server/worker.py` (SQS Consumer)

---

## Key Responsibilities

### 📥 Asynchronous Queue Worker (High Concurrency / Event-Driven)
- **Queue Source**: Amazon SQS (`helpme-ai-jobs-queue`) triggered by S3 `ObjectCreated` EventBridge notifications.
- **Workflow**:
  1. Client uploads image to S3 via Presigned URL (`raw-scans/` or `raw-uploads/`).
  2. S3 emits `ObjectCreated` to EventBridge $\rightarrow$ routed to SQS.
  3. `worker.py` downloads image, validates face & anti-spoofing, generates 512-d vector via EdgeFace, and performs `pgvector` similarity search or citizen registration.
  4. Saves match/status in DynamoDB (`helpme-scan-jobs`) with 2-hour TTL and creates 1-hour access sessions (`helpme-access-sessions`).
  5. Emits `victim.identified` to EventBridge (`EMERGENCY_BUS`) to notify emergency contacts and hospital units.

