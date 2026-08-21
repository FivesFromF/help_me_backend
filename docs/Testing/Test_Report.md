# API Test Report

> [!warning] Generated file — `npm run test:api` overwrites it on every run. Edit `test/api-test/README.md` instead; that is the catalogue of intended cases.

**Run at:** 2026-08-21 16:06:02 UTC  
**Result:** 58/59 passed (98%)

---

## 📊 By suite

| Suite | Passed | Total |
| :-- | --: | --: |
| Health | 2 | 2 |
| Citizen API | 9 | 9 |
| NFC & Scan API | 11 | 11 |
| Emergency API | 9 | 9 |
| Registration | 7 | 8 |
| Events | 7 | 7 |
| Workers | 7 | 7 |
| Async Jobs | 6 | 6 |
| **Total** | **58** | **59** |

## ❌ Failures

### PUT /api/citizen/profile — Partial edit must not silently grant consent

- **Suite:** Registration
- **Expected status:** 200 · **Got:** 200
- **Details:** consentRegulation flipped false → true although the request never mentioned consent (citizen.routes.ts:30 `body.consentRegulation ?? true`)


## ⏳ Not yet covered

58/59 passing says nothing about what was never checked. Open gaps, newest concern first:

### 🔴 Header auth bypass (`x-cognito-id`)

- **Why it matters:** `auth.ts` defines SKIP_AUTH but never checks it on the header branch, so a forged `x-cognito-id` authenticates as that user with no token — confirmed against the running containers (no header → 401, forged header → 404, i.e. authenticated then not-found). `x-role` sets the role the same way.
- **Status:** To be tested by the owner. Fixing it means the 59 checks here must run with SKIP_AUTH=true, since every one of them authenticates by header.

### `post-confirmation` worker

- **Why it matters:** The only worker with no coverage. It creates the citizen skeleton row on Cognito signup, so a regression breaks every new registration silently — nothing else writes that row.
- **Status:** To be tested next.

### Face-recognition happy paths (W-04, W-06, CW-06, S-01 FACE)

- **Why it matters:** Need the Python AI service in the request path, plus a real face image.
- **Status:** The AI pipeline itself is covered separately by `test/ai-test/`.

### The S3 → SQS → worker.py leg

- **Why it matters:** §11 covers both ends (job created, job polled) but not the middle: a real upload to the presigned URL, the ObjectCreated event, and the queue delivery.
- **Status:** Blocked on a config mismatch too — `.env` signs URLs for AWS_S3_BUCKET=helpme-avatars-bucket while local-infra creates helpme-avatars-local, and upload.routes.ts reads a third name (S3_AVATARS_BUCKET_NAME) into a variable it never uses.

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
| 12 | ✅ | NFC & Scan API | POST | `/api/nfc` | Register NFC card & calculate burnable Hash ID | 200 | 200 |
| 13 | ✅ | NFC & Scan API | POST | `/api/nfc` | Reject NFC registration missing serial number (tagId) | 400 | 400 |
| 14 | ✅ | NFC & Scan API | POST | `/api/scan` | Responder NFC scan resolves victim & medical profile | 200 | 200 |
| 15 | ✅ | NFC & Scan API | POST | `/api/scan` | Reject NFC scan with invalid / tampered hash ID | 403 | 403 |
| 16 | ✅ | NFC & Scan API | POST | `/api/nfc` | Reject admin NFC registration without citizenId | 400 | 400 |
| 17 | ✅ | NFC & Scan API | POST | `/api/nfc` | Admin citizenId is never validated (FK violation surfaces as 500) | 500 | 500 |
| 18 | ✅ | NFC & Scan API | POST | `/api/nfc` | Re-registering an existing tagId updates rather than duplicating | 200 | 200 |
| 19 | ✅ | NFC & Scan API | POST | `/api/scan` | Reject NFC scan missing tagId and hashId | 400 | 400 |
| 20 | ✅ | NFC & Scan API | POST | `/api/scan` | Return 404 for unknown or inactive NFC tag | 404 | 404 |
| 21 | ✅ | NFC & Scan API | POST | `/api/scan` | Reject FACE scan without imageBase64 | 400 | 400 |
| 22 | ✅ | NFC & Scan API | POST | `/api/scan` | Reject unsupported scan method (QR) | 400 | 400 |
| 23 | ✅ | Emergency API | POST | `/api/emergency/report` | File incident emergency report with GPS coordinates | 201 | 201 |
| 24 | ✅ | Emergency API | POST | `/api/emergency/report` | Reject emergency report missing GPS coordinates | 400 | 400 |
| 25 | ✅ | Emergency API | POST | `/api/upload-url` | Generate presigned S3 URL for async biometric processing | 200 | 200 |
| 26 | ✅ | Emergency API | GET | `/api/victim/:victimId` | Block unauthorized victim record access without active session | 403 | 403 |
| 27 | ✅ | Emergency API | GET | `/api/scan/jobs/:jobId` | Return 404 when querying non-existent scan job ID | 404 | 404 |
| 28 | ✅ | Emergency API | POST | `/api/emergency/report` | Accept anonymous incident report without victimId | 201 | 201 |
| 29 | ✅ | Emergency API | GET | `/api/victim/:victimId` | Active access session grants victim record retrieval | 200 | 200 |
| 30 | ✅ | Emergency API | GET | `/api/victim/:victimId` | Expired access session is refused | 403 | 403 |
| 31 | ✅ | Emergency API | GET | `/api/victim/:victimId` | Return 404 when session is valid but victim row is absent | 404 | 404 |
| 32 | ✅ | Registration | PUT | `/api/citizen/profile` | First declaration persists all submitted fields | 200 | 200 |
| 33 | ✅ | Registration | GET | `/api/citizen/profile` | Registered information reads back via read service | 200 | 200 |
| 34 | ❌ | Registration | PUT | `/api/citizen/profile` | Partial edit must not silently grant consent | 200 | 200 |
| 35 | ✅ | Registration | PUT | `/api/citizen/profile` | Explicit consentRegulation:false is stored | 200 | 200 |
| 36 | ✅ | Registration | PUT | `/api/citizen/profile` | Reject profile declaration by admin role | 403 | 403 |
| 37 | ✅ | Registration | PUT | `/api/citizen/profile` | Unknown role 'staff' falls through to citizen (fail-open) | 200 | 200 |
| 38 | ✅ | Registration | PUT | `/api/citizen/profile` | Reject declaration for non-existent citizen row | 404 | 404 |
| 39 | ✅ | Registration | GET | `/api/citizen/profile` | Return 404 for unregistered citizen profile | 404 | 404 |
| 40 | ✅ | Events | PUT | `/api/citizen/profile` | Profile update publishes → "citizen.profile.updated" | 200 | 200 |
| 41 | ✅ | Events | PUT | `/api/citizen/profile` | Accepting consent publishes → "user.consent_accepted" | 200 | 200 |
| 42 | ✅ | Events | PUT | `/api/citizen/medical-record` | Medical record write publishes → "medical_record.updated" | 200 | 200 |
| 43 | ✅ | Events | POST | `/api/nfc` | NFC registration publishes → "nfc.registered" | 200 | 200 |
| 44 | ✅ | Events | POST | `/api/emergency/report` | Emergency report publishes → "emergency.reported" | 201 | 201 |
| 45 | ✅ | Events | POST | `/api/scan` | Successful scan publishes → "victim.identified" | 200 | 200 |
| 46 | ✅ | Events | GET | `/api/victim/:victimId` | Granted victim access publishes → "victim.record.accessed" | 200 | 200 |
| 47 | ✅ | Workers | EVENT | `grant-permission-worker` | victim.identified grants a 1-hour access session | 1 | 1 |
| 48 | ✅ | Workers | GET | `/api/victim/:victimId` | Session written by the worker unlocks the victim record | 200 | 200 |
| 49 | ✅ | Workers | EVENT | `audit-worker` | System event is written to the audit trail | 1 | 1 |
| 50 | ✅ | Workers | EVENT | `audit-worker` | Actorless event is audited under actor 'system' | 1 | 1 |
| 51 | ✅ | Workers | EVENT | `notification-worker` | victim.identified alerts the emergency contact by email | 1 | 1 |
| 52 | ✅ | Workers | EVENT | `notification-worker` | Unknown victim sends no alert | 1 | 1 |
| 53 | ✅ | Workers | EVENT | `grant-permission-worker` | Event without a victim writes no session | 1 | 1 |
| 54 | ✅ | Async Jobs | POST | `/api/upload-url` | upload-url opens a PENDING FACE_SCAN job | 200 | 200 |
| 55 | ✅ | Async Jobs | POST | `/api/upload-url` | FACE_ENROLL becomes an ENROLLMENT job under raw-uploads/ | 200 | 200 |
| 56 | ✅ | Async Jobs | POST | `/api/upload-url` | Presigned upload URL is signed, expiring and key-scoped | 200 | 200 |
| 57 | ✅ | Async Jobs | GET | `/api/scan/jobs/:jobId` | Polling a fresh job reports PENDING | 200 | 200 |
| 58 | ✅ | Async Jobs | GET | `/api/scan/jobs/:jobId` | Completed job surfaces the worker's match result | 200 | 200 |
| 59 | ✅ | Async Jobs | GET | `/api/scan/jobs/:jobId` | Failed job surfaces the rejection reason | 200 | 200 |

---

Prerequisites and how to run: [[Runbooks/Local_Testing]] · Endpoint contracts: [[Services/API_Reference_and_Tests]]
