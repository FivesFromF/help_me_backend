# AI Server Service

- **Runtime**: Python 3.12+ / FastAPI / Uvicorn / Boto3 / PyTorch
- **Port**: `8000`
- **Entry Point**: `src/services/ai-server/main.py`
- **Background Worker**: `src/services/ai-server/worker.py` (SQS Consumer)

---

## Key Responsibilities & Dual Execution Modes

### 1. 📥 Asynchronous Queue Worker (High Concurrency / Batch)
- **Queue Source**: Amazon SQS (`helpme-ai-jobs-queue`) triggered by S3 `ObjectCreated` EventBridge notifications.
- **Workflow**:
  1. Client uploads image to S3 via Presigned URL (`raw-scans/` or `raw-uploads/`).
  2. S3 emits `ObjectCreated` to EventBridge $\rightarrow$ routed to SQS.
  3. `worker.py` downloads image, generates 512-d vector, and performs `pgvector` similarity search or citizen registration.
  4. Saves match/status in DynamoDB (`helpme-scan-jobs`) with 2-hour TTL and creates 1-hour access sessions (`helpme-access-sessions`).

### 2. ⚡ Synchronous Fast Path (Emergency Real-Time API)
- **`POST /extract-embedding`**: Direct synchronous multipart/form-data upload for sub-second facial feature extraction.
- **`GET /health`**: Container health probe for ALB and ECS orchestrator.
