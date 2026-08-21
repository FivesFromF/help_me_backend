# AI Service (Biometric Worker)

- **Runtime**: Python 3.12+ / PyTorch / MediaPipe / Boto3 / Psycopg2
- **Entry Point**: `src/services/ai-server/main.py`
- **Worker Logic**: `src/services/ai-server/worker.py` (SQS Consumer)

---

## Key Responsibilities

### 📥 1. Asynchronous SQS Queue Worker (Event-Driven)
- **Queue Source**: Amazon SQS (`helpme-ai-jobs-queue`) triggered by S3 `ObjectCreated` EventBridge notifications.
- **Workflow**:
  1. Client requests a Presigned S3 URL via `POST /api/v1/write/upload-url`.
  2. Client uploads image directly to S3 (`raw-scans/` or `raw-uploads/`).
  3. S3 emits `ObjectCreated` to EventBridge $\rightarrow$ routed to `helpme-ai-jobs-queue`.
  4. `worker.py` downloads image, runs MediaPipe quality validation, MiniFASNet anti-spoofing check, and EdgeFace 512-d feature extraction.
  5. **Face Search Mode**:
     - Executes PostgreSQL `pgvector` nearest-neighbor distance query (`<=>`) with `LIMIT 3` and distance threshold `< 0.35`.
     - Returns the **Top 3 matching candidates** with full profile and medical records.
     - Saves results in DynamoDB (`helpme-scan-jobs`) with a 2-hour TTL.
     - Grants a 1-hour temporary session in `helpme-access-sessions` for the primary match.
     - Dispatches `victim.identified` to EventBridge (`EMERGENCY_BUS`) for automated responder notifications.
  6. **Face Enrollment Mode**:
     - Updates `citizens.face_embedding` in PostgreSQL with the normalized 512-float vector.
     - Updates job status to `COMPLETED` in DynamoDB.

---

## 🔬 2. AI Biometric Pipeline

```
Raw Image (OpenCV)
  │
  ▼
1. MediaPipe Face Landmarker (face_landmarker.task)
   ├─ Checks: Face presence, yaw/pitch within ±15°, face area ratio 10%–50%
   └─ Rejection: Returns specific error ("Face tilted", "Face too far", etc.)
  │
  ▼
2. Anti-Spoofing MiniFASNetV2 (2.7_80x80_MiniFASNetV2.pth)
   ├─ Checks: Distinguishes live face vs photo/screen spoofing
   └─ Rejection: Rejects spoofing attempts
  │
  ▼
3. EdgeFace Feature Extractor (edgeface_s_gamma_05.pt)
   ├─ Normalization: Resizes crop to 112x112, (img - 127.5) / 128.0
   └─ Output: 512-dimensional L2-normalized float vector
```

---

## 🧪 3. Local Image Extraction & Testing (`database-temp.json`)

For standalone local biometric extraction and testing without external cloud dependencies:

- **Script**: `test/ai-test/process_images_to_json.py`
- **Input Directory**: `test/ai-test/test-images/input/`
- **Local JSON DB**: `test/ai-test/test-images/output/database-temp.json`

### CLI Commands:
```bash
# Index all real images in test-images/input/ into database-temp.json
python test/ai-test/process_images_to_json.py

# Process a specific image file
python test/ai-test/process_images_to_json.py --image "path/to/face.jpg"

# Search and match an image against database-temp.json (Top 3 Candidates + Avatar path)
python test/ai-test/process_images_to_json.py --search "path/to/victim.jpg"
```

---

## 🧪 4. What the API-side tests cover

`npm run test:api` §11 covers the two ends this service sits between: `POST /api/upload-url`
creating a `PENDING` job with the right operation, key prefix and TTL, and
`GET /api/scan/jobs/:jobId` reporting `PENDING` → `COMPLETED` (with `result`) → `FAILED` (with
`error`). The worker's DynamoDB write is simulated, so the pipeline itself is *not* under test
there — that is what `test/ai-test/` is for.

Still uncovered: the middle leg (real upload → `ObjectCreated` → SQS → `worker.py`). See the
pending list in [[Testing/Test_Report]], including the bucket-name mismatch that blocks it.
