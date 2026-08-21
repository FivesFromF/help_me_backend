# API Test Report

> [!warning] Generated file — `npm run test:api` overwrites it on every run. Edit `test/api-test/README.md` instead; that is the catalogue of intended cases.

**Run at:** 2026-08-21 15:36:13 UTC  
**Result:** 45/46 passed (98%)

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
| **Total** | **45** | **46** |

## ❌ Failures

### PUT /api/citizen/profile — Partial edit must not silently grant consent

- **Suite:** Registration
- **Expected status:** 200 · **Got:** 200
- **Details:** consentRegulation flipped false → true although the request never mentioned consent (citizen.routes.ts:30 `body.consentRegulation ?? true`)


## 🧾 All checks

|   # |     | Suite          | Method | Endpoint                      | Check                                                             | Expected | Got |
| --: | :-: | :------------- | :----- | :---------------------------- | :---------------------------------------------------------------- | -------: | --: |
|   1 |  ✅  | Health         | GET    | `/health`                     | Write service health probe                                        |      200 | 200 |
|   2 |  ✅  | Health         | GET    | `/health`                     | Read service health probe                                         |      200 | 200 |
|   3 |  ✅  | Citizen API    | PUT    | `/api/citizen/profile`        | Update profile & accept consent regulation                        |      200 | 200 |
|   4 |  ✅  | Citizen API    | PUT    | `/api/citizen/profile`        | Reject unauthenticated profile update                             |      401 | 401 |
|   5 |  ✅  | Citizen API    | PUT    | `/api/citizen/medical-record` | Create / Update emergency medical record                          |      200 | 200 |
|   6 |  ✅  | Citizen API    | POST   | `/api/citizen/face`           | Reject biometric registration without image                       |      400 | 400 |
|   7 |  ✅  | Citizen API    | GET    | `/api/citizen/profile`        | Retrieve authenticated citizen demographic profile                |      200 | 200 |
|   8 |  ✅  | Citizen API    | GET    | `/api/citizen/medical-record` | Retrieve citizen emergency medical facts                          |      200 | 200 |
|   9 |  ✅  | Citizen API    | GET    | `/api/citizen/nfc-tags`       | List registered NFC hardware tags linked to citizen               |      200 | 200 |
|  10 |  ✅  | Citizen API    | PUT    | `/api/citizen/medical-record` | Reject medical record write for absent citizen row                |      404 | 404 |
|  11 |  ✅  | Citizen API    | GET    | `/api/citizen/medical-record` | Absent medical record returns 200 with empty object (not 404)     |      200 | 200 |
|  12 |  ✅  | NFC & Scan API | POST   | `/api/nfc`                    | Register NFC card & calculate burnable Hash ID                    |      200 | 200 |
|  13 |  ✅  | NFC & Scan API | POST   | `/api/nfc`                    | Reject NFC registration missing serial number (tagId)             |      400 | 400 |
|  14 |  ✅  | NFC & Scan API | POST   | `/api/scan`                   | Responder NFC scan resolves victim & medical profile              |      200 | 200 |
|  15 |  ✅  | NFC & Scan API | POST   | `/api/scan`                   | Reject NFC scan with invalid / tampered hash ID                   |      403 | 403 |
|  16 |  ✅  | NFC & Scan API | POST   | `/api/nfc`                    | Reject admin NFC registration without citizenId                   |      400 | 400 |
|  17 |  ✅  | NFC & Scan API | POST   | `/api/nfc`                    | Admin citizenId is never validated (FK violation surfaces as 500) |      500 | 500 |
|  18 |  ✅  | NFC & Scan API | POST   | `/api/nfc`                    | Re-registering an existing tagId updates rather than duplicating  |      200 | 200 |
|  19 |  ✅  | NFC & Scan API | POST   | `/api/scan`                   | Reject NFC scan missing tagId and hashId                          |      400 | 400 |
|  20 |  ✅  | NFC & Scan API | POST   | `/api/scan`                   | Return 404 for unknown or inactive NFC tag                        |      404 | 404 |
|  21 |  ✅  | NFC & Scan API | POST   | `/api/scan`                   | Reject FACE scan without imageBase64                              |      400 | 400 |
|  22 |  ✅  | NFC & Scan API | POST   | `/api/scan`                   | Reject unsupported scan method (QR)                               |      400 | 400 |
|  23 |  ✅  | Emergency API  | POST   | `/api/emergency/report`       | File incident emergency report with GPS coordinates               |      201 | 201 |
|  24 |  ✅  | Emergency API  | POST   | `/api/emergency/report`       | Reject emergency report missing GPS coordinates                   |      400 | 400 |
|  25 |  ✅  | Emergency API  | POST   | `/api/upload-url`             | Generate presigned S3 URL for async biometric processing          |      200 | 200 |
|  26 |  ✅  | Emergency API  | GET    | `/api/victim/:victimId`       | Block unauthorized victim record access without active session    |      403 | 403 |
|  27 |  ✅  | Emergency API  | GET    | `/api/scan/jobs/:jobId`       | Return 404 when querying non-existent scan job ID                 |      404 | 404 |
|  28 |  ✅  | Emergency API  | POST   | `/api/emergency/report`       | Accept anonymous incident report without victimId                 |      201 | 201 |
|  29 |  ✅  | Emergency API  | GET    | `/api/victim/:victimId`       | Active access session grants victim record retrieval              |      200 | 200 |
|  30 |  ✅  | Emergency API  | GET    | `/api/victim/:victimId`       | Expired access session is refused                                 |      403 | 403 |
|  31 |  ✅  | Emergency API  | GET    | `/api/victim/:victimId`       | Return 404 when session is valid but victim row is absent         |      404 | 404 |
|  32 |  ✅  | Registration   | PUT    | `/api/citizen/profile`        | First declaration persists all submitted fields                   |      200 | 200 |
|  33 |  ✅  | Registration   | GET    | `/api/citizen/profile`        | Registered information reads back via read service                |      200 | 200 |
|  34 |  ❌  | Registration   | PUT    | `/api/citizen/profile`        | Partial edit must not silently grant consent                      |      200 | 200 |
|  35 |  ✅  | Registration   | PUT    | `/api/citizen/profile`        | Explicit consentRegulation:false is stored                        |      200 | 200 |
|  36 |  ✅  | Registration   | PUT    | `/api/citizen/profile`        | Reject profile declaration by admin role                          |      403 | 403 |
|  37 |  ✅  | Registration   | PUT    | `/api/citizen/profile`        | Unknown role 'staff' falls through to citizen (fail-open)         |      200 | 200 |
|  38 |  ✅  | Registration   | PUT    | `/api/citizen/profile`        | Reject declaration for non-existent citizen row                   |      404 | 404 |
|  39 |  ✅  | Registration   | GET    | `/api/citizen/profile`        | Return 404 for unregistered citizen profile                       |      404 | 404 |
|  40 |  ✅  | Events         | PUT    | `/api/citizen/profile`        | Profile update publishes → "citizen.profile.updated"              |      200 | 200 |
|  41 |  ✅  | Events         | PUT    | `/api/citizen/profile`        | Accepting consent publishes → "user.consent_accepted"             |      200 | 200 |
|  42 |  ✅  | Events         | PUT    | `/api/citizen/medical-record` | Medical record write publishes → "medical_record.updated"         |      200 | 200 |
|  43 |  ✅  | Events         | POST   | `/api/nfc`                    | NFC registration publishes → "nfc.registered"                     |      200 | 200 |
|  44 |  ✅  | Events         | POST   | `/api/emergency/report`       | Emergency report publishes → "emergency.reported"                 |      201 | 201 |
|  45 |  ✅  | Events         | POST   | `/api/scan`                   | Successful scan publishes → "victim.identified"                   |      200 | 200 |
|  46 |  ✅  | Events         | GET    | `/api/victim/:victimId`       | Granted victim access publishes → "victim.record.accessed"        |      200 | 200 |

---

Prerequisites and how to run: [[Runbooks/Local_Testing]] · Endpoint contracts: [[Services/API_Reference_and_Tests]]
