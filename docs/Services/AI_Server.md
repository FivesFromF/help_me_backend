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

## 🚫 The synchronous path is deprecated

`POST /api/citizen/face` and `POST /api/scan { method: "FACE" }` do **not** reach this service.
Both call `extractFaceFeature` in `shared/services/ai.service.ts`, which invokes an AWS Lambda named
by **`AI_LAMBDA_NAME`** and, when that variable is unset, throws before reading the payload:

```
Synchronous face extraction endpoint is deprecated. Use async Presigned S3 upload + SQS AI Worker flow.
```

`AI_LAMBDA_NAME` is set nowhere in this repo — not `.env`, not `infra/**.tf`, not
`docker-compose.yaml` — so both routes return **500** in every environment. Starting `main.py`
changes nothing: it is an SQS consumer with no HTTP surface, and nothing on that path reaches it.
`.env`'s `AI_SERVER_URL` and `AI_INTERNAL_SECRET` are read by no code in `src/` or `test/`.

The behaviour is pinned by `F-01`–`F-04` in [[Services/API_Reference_and_Tests]]. Reviving the
path means setting `AI_LAMBDA_NAME` and deploying that Lambda; face recognition otherwise runs
only through the async queue above.

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

### ⚠️ OpenCV must stay on 4.x

Stage 2's detector is loaded with `cv2.dnn.readNetFromCaffe` from a vendored `.caffemodel`
(`anti_spoofing/src/anti_spoof_predict.py:28`, `Widerface-RetinaFace.caffemodel`) — OpenCV's DNN
module *is* the inference engine here, not just image plumbing. **OpenCV 5.0 removed the Caffe
importer outright**: `readNetFromCaffe` no longer exists, and `readNet` refuses the same file with
`Caffe importer has been removed. Please use ONNX-converted models or use an older OpenCV version.`

`requirements.txt` originally said `opencv-python-headless>=4.8.0` with no upper bound, so the first
image build after OpenCV 5.0's release silently jumped major versions and every job failed with
`module 'cv2.dnn' has no attribute 'readNetFromCaffe'`. Both packages are now pinned `<5` —
`opencv-contrib-python` too, because mediapipe pulls it in and does not bound it either.

This is not local-only: `requirements.txt` builds the **production** image as well. The permanent
fix is converting the detector weights to ONNX, which needs its own accuracy validation.

### ⚠️ Nothing written to DynamoDB may be a Python `float`

boto3's DynamoDB resource rejects floats outright (`Float types are not supported. Use Decimal
types instead`) and raises at write time. Because a matched scan writes its distance into the job
record, **every successful match used to die at the write**: the exception was logged, the job never
left `PROCESSING`, and the client polled forever on a scan that had actually succeeded. The pgvector
match was never at fault. This affected real AWS exactly as much as the emulator.

`update_job_status()` now routes its `result` through `_to_dynamo_safe()`, which converts floats to
`Decimal` at the boundary so no call site can reintroduce the bug. It unwraps numpy scalars first —
pgvector distances arrive as `np.float64`, which is **not** a `float` subclass, so an
`isinstance(x, float)` test alone misses them.

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

Still uncovered: the middle leg (real upload → `ObjectCreated` → SQS → `worker.py`). The bucket
names now agree on `helpme-avatars-local` everywhere and the worker reaches SQS, S3, EventBridge,
DynamoDB and Postgres from its container (see [[Runbooks/Local_Testing]]), but nothing locally turns
an S3 `ObjectCreated` into an SQS message — `local-infra` declares the queue and no notification
rule — so a job must be enqueued by hand. `npm run test:pipeline`
(`test/ai-test/pipeline_probe.ts`) does exactly that: it enrolls a face, scans it back and asserts
the match, the granted session and the job result. **It passes all seven checks as of 2026-08-22**,
which is the first time this path has run end to end; getting there took the OpenCV pin and the
`Decimal` fix above, plus three emulator corrections in [[Runbooks/Local_Testing]].

`test/ai-test/presign_check.ts` covers the one leg the probe bypasses — the presigned `PUT` the
Flutter app uses, which the probe sidesteps by writing to S3 with its own client.

Any happy-path fixture must be `plain-avatar.jpg`: every large `.png` in `test-images/input/` is a
screen capture and is correctly rejected by stage 2 (see that folder's `README.md`). Open gaps are
tracked in [[Testing/Test_Report]].
