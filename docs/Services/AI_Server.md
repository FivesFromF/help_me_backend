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
     - Returns **up to 3 candidates** with full profile and medical records. *Up to*: the threshold
       filters before the limit, so a scan that matches one person returns one.
     - Resolves complaints for the **whole candidate set** in one query on the cursor already open.
       A complained citizen is dropped before their record is fetched, so it never enters the
       payload — checking only the top match would leak candidates 2 and 3 to a responder they had
       already revoked. If every candidate is suppressed the job returns `ACCESS_REVOKED`. The result
       reports `suppressedCount`: how many were withheld, never who.
     - Saves results in DynamoDB (`helpme-scan-jobs`) with a 2-hour TTL (scans only — see enrolment below).
     - Masks `cccdNumber` to its last four digits **before writing**, not on the way out — the job
       record is what the responder reads, so masking at read time would leave the full number stored
       in a second place. `mask_cccd` mirrors `maskCccd` in `shared/services/mask.service.ts`; both
       are idempotent. See [[Architecture/Authentication_and_Audit]].
     - Grants a **12-hour** session in Postgres `access_sessions` for **every candidate returned**,
       not just the primary. If a person's medical record is in the response, that access has to be
       visible on their history page and open to complaint.
     - Dispatches `victim.identified` to EventBridge (`EMERGENCY_BUS`) for the **primary only**. That
       event drives the next-of-kin alert; firing it for candidates 2 and 3 would tell two uninvolved
       families their relative is in an emergency. Granting is accountability, alerting is a claim
       about reality.
  6. **Face Enrollment Mode**:
     - Re-reads the job record to recover `citizen_id`, then updates `citizens.face_embedding` in
       PostgreSQL with the normalized 512-float vector and sets `is_verified = true`, using
       `RETURNING id` because the job's `citizen_id` may be a `cognito_id`.
     - Then server-side-copies the image to **`avatars/<citizenId>.jpg`** and stores that key in
       `citizens.avatar_url`. The copy is what lets `raw-uploads/` be expired by a lifecycle rule
       without breaking every avatar. A failed copy leaves the previous avatar untouched and does
       **not** fail the enrolment. Only enrolment does this; a `raw-scans/` image is a responder's
       photo of a victim and must never become that person's profile picture.

> [!warning] The avatar copy must never land under `raw-uploads/` or `raw-scans/`.
> The EventBridge rule filters exactly those two prefixes (`infra/modules/sqs/main.tf`), so a copy to
> `avatars/` raises no event. Copy into either watched prefix and the new object is processed as a
> **scan**: a phantom job, an access session granted, `victim.identified` published, and emergency
> contacts emailed about an incident that never happened.
     - `avatar_url` holds a key, not a URL, because the bucket blocks all public access — a stored
       `https://` object URL would `403` forever. Read paths sign it on the way out with
       `resolveAvatarUrl()` (`shared/services/s3.service.ts`), which passes absolute URLs (seed data,
       externally hosted images) through untouched and returns `null` rather than throwing. Every
       responder-facing path signs it — scan, job polling, victim re-access, admin, history — so a
       path that forgets hands the client a bare key and renders a broken image.
     - **A signed URL outlives the session that produced it.** `resolveAvatarUrl` signs for 1 hour,
       independent of the 12-hour grant, and S3 cannot revoke an issued signature. A complaint blocks
       the API instantly but an already-issued avatar link keeps serving for up to an hour.
     - Updates job status to `COMPLETED` in DynamoDB.
     - **`COMPLETED` is only written when a row was actually updated.** A missing/expired job record
       (no `citizen_id`) or an `UPDATE` matching zero rows both end as `FAILED` with an explicit
       error. Until 2026-08-22 both cases returned `enrolled: true` with nothing written — the
       client was told enrolment succeeded while `face_embedding` stayed null.
     - Enrolment jobs carry a **25-hour TTL**, deliberately longer than the queue's 24-hour message
       retention, so a job record can never expire out from under its own message. Scan jobs keep
       the 2-hour TTL because their result payload holds the victim's medical record.

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

### ⚠️ The AI task needs its own path into RDS

SQS, S3 and DynamoDB are public endpoints, so the worker reaches them from anywhere. Postgres is not.
`aws_security_group_rule.ai_tasks_to_rds` (declared in `infra/main.tf`, not inside `modules/rds`, so
`rds` never has to depend on `ai_service` — which already depends on it for the endpoint) opens 5432
from the AI task's security group.

Without it the container reaches every AWS service and still fails every job at
`Database connection unavailable`. A blocked security group **drops** packets rather than refusing
them, so the failure is a timeout, not a connection error — and `psycopg2` hangs for ~131s unless
`connect_timeout` is set, which exceeds the queue's 120s `VisibilityTimeout` and gets the message
redelivered while the worker still holds it. `get_db_connection()` passes `connect_timeout=10`.

### ⚠️ Endpoints and credentials — `LOCAL_AWS_EMULATION`

`worker.py` builds four boto3 clients (SQS, S3, DynamoDB, EventBridge). Until 2026-08-22 each one
defaulted to a **localhost emulator address** when its env var was absent, and the module also ran
`os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")` unconditionally. The Fargate task definition
sets no endpoint variables, so the deployed worker:

- polled `http://localhost:9324` — itself — while `AI_JOBS_QUEUE_URL` pointed at the real queue, and
- wrote `AWS_ACCESS_KEY_ID=test` over the ECS task role, because env vars outrank the container
  credential provider in boto3's chain.

Both faults are silent. The task reports `RUNNING`, the service reaches steady state, and the loop
logs `Error polling SQS` every five seconds — into a log group that did not exist, so nothing was
visible anywhere. A `FACE_ENROLL` job sat at `PENDING` with its message `Available` and
`NotVisible: 0` until someone read the queue counters by hand.

The switch is now explicit:

| `LOCAL_AWS_EMULATION` | Endpoints | Credentials |
| :-- | :-- | :-- |
| `true` | ElasticMQ / s3rver / DynamoDB Local / offline EventBridge | dummy `test` keys installed |
| unset (cloud, **default**) | `None` → boto3 resolves the real regional endpoint | ECS task role, untouched |

An explicit `SQS_ENDPOINT_URL` / `S3_ENDPOINT_URL` / `DYNAMODB_ENDPOINT` / `AWS_ENDPOINT_URL` still
wins in either mode. The default had to become real AWS: a wrong endpoint locally fails on the first
poll, while a wrong endpoint in cloud fails silently for as long as nobody looks.

Startup now logs the resolved mode (`AWS mode=real AWS sqs=default …`), and a stalled poll loop
escalates at 5 and 50 consecutive failures instead of repeating one line forever. If enrollment jobs
stick at `PENDING`, read the queue counters first — `Available > 0` with `NotVisible: 0` means
nothing is consuming, which is a worker-wiring fault, never a slow model.

> The main queue keeps messages for **1 day** (`infra/modules/sqs/main.tf:17`), not the AWS default
> of four. A backlog that outlives an outage is gone, and the client must re-upload.

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
