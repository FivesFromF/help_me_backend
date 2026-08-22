# API Test Report

> [!warning] Generated file — `npm run test:api` overwrites it on every run. Edit `test/api-test/README.md` instead; that is the catalogue of intended cases.

**Run at:** 2026-08-22 10:08:06 UTC  
**Result:** 75/75 passed (100%)

---

## 📊 By suite

| Suite | Passed | Total |
| :-- | --: | --: |
| Health | 2 | 2 |
| Citizen API | 9 | 9 |
| NFC & Credentials API | 23 | 23 |
| Emergency API | 9 | 9 |
| Registration | 8 | 8 |
| Events | 7 | 7 |
| Workers | 7 | 7 |
| Async Jobs | 6 | 6 |
| Face (sync path) | 4 | 4 |
| **Total** | **75** | **75** |

## ❌ Failures

None — every check passed.

## ⏳ Not yet covered

75/75 passing says nothing about what was never checked. Open gaps, newest concern first:

### 🟠 `post-confirmation` worker (PC-01–PC-06)

- **Why it matters:** The only worker with no coverage, and the sole writer of the citizen skeleton row on Cognito signup — no HTTP route creates a citizen, so a regression breaks every new registration silently. Worse, the handler cannot report its own failure: the whole body sits in one `try` whose `catch` only logs, and `main` returns the event regardless, so a Cognito error (the first await, before the insert) or the `email @unique` collision on a second attribute-less signup leaves a confirmed user with no profile and no retry. Six cases are designed in `test/api-test/README.md` §14: row created (PC-01), group membership honoured (PC-02, PC-03), idempotency (PC-04), `user.signed_up` reaching the audit trail (PC-05), and the silent-failure defect (PC-06).
- **Status:** To be tested by the owner. Note the wiring: this handler builds `new EventBridgeClient({})` with no endpoint override — the only publisher in `src/` that does — so `event_capture.ts` cannot see it. PC-05 needs AWS_ENDPOINT_URL_EVENTBRIDGE and the Cognito stub needs AWS_ENDPOINT_URL_COGNITO_IDENTITY_PROVIDER, both set before a dynamic import.

### Face recognition through the API (W-04, W-06, CW-06, S-01 FACE)

- **Why it matters:** These happy paths cannot pass as written: `ai.service.ts:6` invokes an AI Lambda named by AI_LAMBDA_NAME and throws "Synchronous face extraction endpoint is deprecated" when it is unset — and it is set nowhere (`.env`, `infra/**.tf`, `docker-compose.yaml`). Running `python main.py` cannot help; `main.py` is an SQS consumer with no HTTP surface. F-01–F-04 (§13) now pin the 500 and the absence of any write or event instead.
- **Status:** Real biometric coverage lives in `test/ai-test/` (the pipeline) and in the async S3 → SQS → worker.py leg below. Reviving the sync path means setting AI_LAMBDA_NAME and deploying that Lambda — at which point F-01–F-04 are the cases to rewrite.

### The S3 → SQS → worker.py leg (covered elsewhere, not here)

- **Why it matters:** §11 covers both ends (job created, job polled) but not the middle: a real upload to the presigned URL and the queue delivery. Nothing in this suite touches S3, SQS or the worker, so it stays green while the whole async path is dead — which is exactly what happened.
- **Status:** `npm run test:pipeline` (test/ai-test/pipeline_probe.ts) now proves that leg end to end: enrollment, embedding in Postgres, is_verified, MATCH_FOUND and the 1-hour session — all seven checks pass as of 2026-08-22. test/ai-test/presign_check.ts covers the presigned PUT the probe bypasses. Still true locally: nothing turns an S3 ObjectCreated into an SQS message (local-infra declares the queue but no notification rule), so both probes enqueue by hand.

## 🧾 All checks

| # | | Suite | Method | Endpoint | Check | Expected | Got |
| --: | :-: | :-- | :-- | :-- | :-- | --: | --: |
| 1 | ✅ | Health | GET | `/health` | Write service health probe | 200 | 200 |
| 2 | ✅ | Health | GET | `/health` | Read service health probe | 200 | 200 |
| 3 | ✅ | Citizen API | PUT | `/api/citizen/profile` | Update profile & accept consent regulation | 200 | 200 |
| 4 | ✅ | Citizen API | PUT | `/api/citizen/profile` | Reject unauthenticated profile update | 401 | 401 |
| 5 | ✅ | Citizen API | PUT | `/api/citizen/medical-record` | Create / Update emergency medical record | 200 | 200 |
| 6 | ✅ | Citizen API | POST | `/api/citizen/face` | Reject biometric registration without image | 400 | 400 |
| 7 | ✅ | Citizen API | GET | `/api/citizen/profile` | Retrieve authenticated citizen demographic profile | 200 | 200 |
| 8 | ✅ | Citizen API | GET | `/api/citizen/medical-record` | Retrieve citizen emergency medical facts | 200 | 200 |
| 9 | ✅ | Citizen API | GET | `/api/citizen/nfc-tags` | List registered NFC hardware tags linked to citizen | 200 | 200 |
| 10 | ✅ | Citizen API | PUT | `/api/citizen/medical-record` | Reject medical record write for absent citizen row | 404 | 404 |
| 11 | ✅ | Citizen API | GET | `/api/citizen/medical-record` | Absent medical record returns 200 with empty object (not 404) | 200 | 200 |
| 12 | ✅ | NFC & Credentials API | POST | `/api/nfc` | Register NFC card & calculate burnable Hash ID | 200 | 200 |
| 13 | ✅ | NFC & Credentials API | POST | `/api/nfc` | Reject NFC registration missing serial number (tagId) | 400 | 400 |
| 14 | ✅ | NFC & Credentials API | POST | `/api/nfc` | Reject admin NFC registration without citizenId | 400 | 400 |
| 15 | ✅ | NFC & Credentials API | POST | `/api/nfc` | Admin citizenId is never validated (FK violation surfaces as 500) | 500 | 500 |
| 16 | ✅ | NFC & Credentials API | POST | `/api/nfc` | Re-registering an existing tagId updates rather than duplicating | 200 | 200 |
| 17 | ✅ | NFC & Credentials API | PATCH | `/api/v1/write/nfc/:tagId/status` | Update NFC tag status to INACTIVE (lockout) | 200 | 200 |
| 18 | ✅ | NFC & Credentials API | PATCH | `/api/v1/write/nfc/:tagId/status` | Reject invalid NFC tag status | 400 | 400 |
| 19 | ✅ | NFC & Credentials API | PATCH | `/api/v1/write/nfc/:tagId/status` | Reactivate NFC tag status to ACTIVE | 200 | 200 |
| 20 | ✅ | NFC & Credentials API | POST | `/api/v1/write/qr` | Issue new emergency QR code with cryptographic HMAC payload | 201 | 201 |
| 21 | ✅ | NFC & Credentials API | GET | `/api/v1/read/citizen/credentials` | List citizen credentials (both NFC tags and QR codes with hashId) | 200 | 200 |
| 22 | ✅ | NFC & Credentials API | PATCH | `/api/v1/write/qr/:qrId/status` | Update QR code status to LOST (lockout) | 200 | 200 |
| 23 | ✅ | NFC & Credentials API | POST | `/api/scan` | Refuse emergency scan for QR code marked LOST / INACTIVE | 404 | 404 |
| 24 | ✅ | NFC & Credentials API | PATCH | `/api/v1/write/qr/:qrId/status` | Reactivate QR code status to ACTIVE | 200 | 200 |
| 25 | ✅ | NFC & Credentials API | POST | `/api/scan` | Responder NFC scan resolves victim & medical profile | 200 | 200 |
| 26 | ✅ | NFC & Credentials API | POST | `/api/scan` | Reject NFC scan with invalid / tampered hash ID | 403 | 403 |
| 27 | ✅ | NFC & Credentials API | POST | `/api/scan` | Responder QR scan resolves victim & medical profile | 200 | 200 |
| 28 | ✅ | NFC & Credentials API | POST | `/api/scan` | Reject QR scan with invalid / tampered hash ID | 403 | 403 |
| 29 | ✅ | NFC & Credentials API | POST | `/api/scan` | Reject QR scan missing qrId and hashId | 400 | 400 |
| 30 | ✅ | NFC & Credentials API | POST | `/api/scan` | Return 404 for unknown or inactive NFC tag | 404 | 404 |
| 31 | ✅ | NFC & Credentials API | POST | `/api/scan` | Reject FACE scan without imageBase64 | 400 | 400 |
| 32 | ✅ | NFC & Credentials API | POST | `/api/scan` | Reject unsupported scan method (BLUETOOTH) | 400 | 400 |
| 33 | ✅ | NFC & Credentials API | DELETE | `/api/v1/write/qr/:qrId` | Delete emergency QR code | 200 | 200 |
| 34 | ✅ | NFC & Credentials API | DELETE | `/api/v1/write/nfc/:tagId` | Unlink physical NFC tag (clears owner, sets INACTIVE) | 200 | 200 |
| 35 | ✅ | Emergency API | POST | `/api/emergency/report` | File incident emergency report with GPS coordinates | 201 | 201 |
| 36 | ✅ | Emergency API | POST | `/api/emergency/report` | Reject emergency report missing GPS coordinates | 400 | 400 |
| 37 | ✅ | Emergency API | POST | `/api/upload-url` | Generate presigned S3 URL for async biometric processing | 200 | 200 |
| 38 | ✅ | Emergency API | GET | `/api/victim/:victimId` | Block unauthorized victim record access without active session | 403 | 403 |
| 39 | ✅ | Emergency API | GET | `/api/scan/jobs/:jobId` | Return 404 when querying non-existent scan job ID | 404 | 404 |
| 40 | ✅ | Emergency API | POST | `/api/emergency/report` | Accept anonymous incident report without victimId | 201 | 201 |
| 41 | ✅ | Emergency API | GET | `/api/victim/:victimId` | Active access session grants victim record retrieval | 200 | 200 |
| 42 | ✅ | Emergency API | GET | `/api/victim/:victimId` | Expired access session is refused | 403 | 403 |
| 43 | ✅ | Emergency API | GET | `/api/victim/:victimId` | Return 404 when session is valid but victim row is absent | 404 | 404 |
| 44 | ✅ | Registration | PUT | `/api/citizen/profile` | First declaration persists all submitted fields | 200 | 200 |
| 45 | ✅ | Registration | GET | `/api/citizen/profile` | Registered information reads back via read service | 200 | 200 |
| 46 | ✅ | Registration | PUT | `/api/citizen/profile` | Partial edit must not silently grant consent | 200 | 200 |
| 47 | ✅ | Registration | PUT | `/api/citizen/profile` | Explicit consentRegulation:false is stored | 200 | 200 |
| 48 | ✅ | Registration | PUT | `/api/citizen/profile` | Reject profile declaration by admin role | 403 | 403 |
| 49 | ✅ | Registration | PUT | `/api/citizen/profile` | Unknown role 'staff' falls through to citizen (fail-open) | 200 | 200 |
| 50 | ✅ | Registration | PUT | `/api/citizen/profile` | Auto-provision citizen row on profile declaration (upsert) | 200 | 200 |
| 51 | ✅ | Registration | GET | `/api/citizen/profile` | Return 404 for unregistered citizen profile | 404 | 404 |
| 52 | ✅ | Events | PUT | `/api/citizen/profile` | Profile update publishes → "citizen.profile.updated" | 200 | 200 |
| 53 | ✅ | Events | PUT | `/api/citizen/profile` | Accepting consent publishes → "user.consent_accepted" | 200 | 200 |
| 54 | ✅ | Events | PUT | `/api/citizen/medical-record` | Medical record write publishes → "medical_record.updated" | 200 | 200 |
| 55 | ✅ | Events | POST | `/api/nfc` | NFC registration publishes → "nfc.registered" | 200 | 200 |
| 56 | ✅ | Events | POST | `/api/emergency/report` | Emergency report publishes → "emergency.reported" | 201 | 201 |
| 57 | ✅ | Events | POST | `/api/scan` | Successful scan publishes → "victim.identified" | 200 | 200 |
| 58 | ✅ | Events | GET | `/api/victim/:victimId` | Granted victim access publishes → "victim.record.accessed" | 200 | 200 |
| 59 | ✅ | Workers | EVENT | `scan route (access_sessions)` | victim.identified grants a 1-hour access session | 1 | 1 |
| 60 | ✅ | Workers | GET | `/api/victim/:victimId` | Session written by the worker unlocks the victim record | 200 | 200 |
| 61 | ✅ | Workers | EVENT | `audit-worker` | System event is written to the audit trail | 1 | 1 |
| 62 | ✅ | Workers | EVENT | `audit-worker` | Actorless event is audited under actor 'system' | 1 | 1 |
| 63 | ✅ | Workers | EVENT | `notification-worker` | victim.identified alerts the emergency contact by email | 1 | 1 |
| 64 | ✅ | Workers | EVENT | `notification-worker` | Unknown victim sends no alert | 1 | 1 |
| 65 | ✅ | Workers | EVENT | `grant-permission-worker` | Event without a victim writes no session | 1 | 1 |
| 66 | ✅ | Async Jobs | POST | `/api/upload-url` | upload-url opens a PENDING FACE_SCAN job | 200 | 200 |
| 67 | ✅ | Async Jobs | POST | `/api/upload-url` | FACE_ENROLL becomes an ENROLLMENT job under raw-uploads/ | 200 | 200 |
| 68 | ✅ | Async Jobs | POST | `/api/upload-url` | Presigned upload URL is signed, expiring and key-scoped | 200 | 200 |
| 69 | ✅ | Async Jobs | GET | `/api/scan/jobs/:jobId` | Polling a fresh job reports PENDING | 200 | 200 |
| 70 | ✅ | Async Jobs | GET | `/api/scan/jobs/:jobId` | Completed job surfaces the worker's match result | 200 | 200 |
| 71 | ✅ | Async Jobs | GET | `/api/scan/jobs/:jobId` | Failed job surfaces the rejection reason | 200 | 200 |
| 72 | ✅ | Face (sync path) | POST | `/api/citizen/face` | Face registration is deprecated without AI_LAMBDA_NAME | 500 | 500 |
| 73 | ✅ | Face (sync path) | POST | `/api/citizen/face` | Failed registration leaves face_embedding and is_verified alone | 500 | 500 |
| 74 | ✅ | Face (sync path) | POST | `/api/citizen/face` | Failed registration publishes no citizen.face.registered | 500 | 500 |
| 75 | ✅ | Face (sync path) | POST | `/api/scan` | FACE scan is deprecated and identifies nobody | 500 | 500 |

---

Prerequisites and how to run: [[Runbooks/Local_Testing]] · Endpoint contracts: [[Services/API_Reference_and_Tests]]
