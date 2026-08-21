# HelpMe API Reference & Automated Test Catalog

Complete reference for all **Write Server (Port 8080)** and **Read Server (Port 8081)** API endpoints, including RBAC authorization requirements, request/response contracts, and test case documentation.

---

## 🧪 Automated Test Runner

To execute all automated API tests against the local database and microservice routers:

```bash
npm run test:api
```

The suite lives in `test/api-test/` — `index.ts` seeds a citizen and runs the per-domain files
(`registration.api.test.ts`, `citizen.api.test.ts`, `nfc_scan.api.test.ts`,
`emergency.api.test.ts`), then tears the data down.
It builds the Express routers in-process on ephemeral ports, so no containers are required.

There is **no filter flag or `-t` option** — the runner always executes every group, and the groups
share the fixtures (citizen id, hash id, tag id) that `index.ts` seeds, so a group cannot simply be
invoked on its own. To narrow a run, comment out calls in `runAllGroupedApiTests()`.

**The full test-case catalog is `test/api-test/README.md`** — keep that file as the source of
truth for expected status codes. As of 2026-08-20 the runner executes **39 checks, 38 passing**:
role rejection, expired sessions, absent-record vs. absent-citizen and unknown tags are all covered
now. The single failure, `R-03`, reproduces a real consent defect (note F in that file).

Still not executed: the face-recognition happy paths (`W-04`, `W-06`, `CW-06`, and the
`method: "FACE"` branch of `S-01`), which need the Python AI service running, and the §9 event
assertions, which need the EventBridge emulator.

Seven checks need DynamoDB on `:8001` (`upload-url`, scan-job polling, the four victim-access
cases) — see the prerequisites table in `test/api-test/README.md`.

---

## 📝 1. Write Server Endpoints (`http://localhost:8080`)

### 1.1 Health Check
- **Route**: `GET /health` or `GET /write-service/health`
- **Auth**: Public (No token required)
- **Response**: `200 OK`
  ```json
  { "status": "ok", "service": "write-server" }
  ```
- **Test Case**: Verifies write service connectivity and target group liveness.

---

### 1.2 Update Citizen Demographic Profile
- **Route**: `PUT /api/v1/write/citizen/profile`
- **Auth**: `requireRole(["citizen"])` (Header: `x-cognito-id: <sub-id>`, `x-role: citizen` or Cognito Bearer JWT)
- **Request Body**:
  ```json
  {
    "fullName": "Pham Minh Duc",
    "phone": "+84988777666",
    "address": "789 Tran Hung Dao, District 5, HCMC",
    "cccdNumber": "079095012345",
    "gender": "MALE",
    "dateOfBirth": "1994-04-12",
    "firstDeclareProfile": true,
    "consentRegulation": true,
    "emergencyContacts": [
      { "name": "Pham Van Father", "phone": "+84911222333", "relation": "Father" }
    ]
  }
  ```
- **Response**: `200 OK`
  ```json
  { "profile": { "id": "uuid", "fullName": "Pham Minh Duc", ... } }
  ```
- **Events Published**: `citizen.profile.updated`, `user.consent_accepted` (to `CORE_SYSTEM_BUS`)
- **Test Cases**:
  1. `[Happy Path]`: Authenticated citizen updates demographics and accepts consent regulation $\rightarrow$ `200 OK`.
  2. `[Negative]`: Unauthenticated request rejected $\rightarrow$ `401 Unauthorized`.

---

### 1.3 Create / Update Citizen Medical Record
- **Route**: `PUT /api/v1/write/citizen/medical-record`
- **Auth**: `requireRole(["citizen"])`
- **Request Body**:
  ```json
  {
    "bloodGroup": "O+",
    "distinguishingMarks": "Small mole under right eye",
    "allergies": ["Penicillin", "Dust Mites"],
    "backgroundDiseases": ["Type 2 Diabetes"],
    "currentMedications": ["Metformin 500mg"],
    "notes": "Diabetic ID wristband in wallet"
  }
  ```
- **Response**: `200 OK`
  ```json
  { "record": { "citizenId": "uuid", "bloodGroup": "O+", ... } }
  ```
- **Events Published**: `medical_record.updated` (to `CORE_SYSTEM_BUS`)
- **Test Case**: Authenticated citizen creates and updates emergency medical facts $\rightarrow$ `200 OK`.

---

### 1.4 Register Biometric Face Embedding
- **Route**: `POST /api/v1/write/citizen/face`
- **Auth**: `requireRole(["citizen"])`
- **Request Body**:
  ```json
  { "imageBase64": "data:image/jpeg;base64,..." }
  ```
- **Response**: `200 OK`
  ```json
  { "success": true, "message": "Face registered successfully" }
  ```
- **Test Case**: Rejects empty image payload with `400 Bad Request`.

---

### 1.5 Register Physical NFC Card
- **Route**: `POST /api/v1/write/nfc`
- **Auth**: `requireRole(["citizen", "admin"])`
- **Request Body**:
  ```json
  {
    "tagId": "NFC_CARD_12345",
    "name": "Smart Medical Wristband",
    "citizenId": "uuid-citizen"
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "success": true,
    "tagId": "NFC_CARD_12345",
    "hashIdToBurn": "3c98d02a9e3a9c7b..."
  }
  ```
- **Logic**: Generates an HMAC-SHA256 hash `HMAC(citizenId, SYSTEM_SECRET)` for write-once burning to the physical NFC chip to prevent cloning.
- **Test Cases**:
  1. `[Happy Path]`: Computes correct tamper-proof `hashIdToBurn` $\rightarrow$ `200 OK`.
  2. `[Negative]`: Missing serial number `tagId` rejected with `400 Bad Request`.

---

### 1.6 File Emergency Incident Report
- **Route**: `POST /api/v1/write/emergency/report`
- **Auth**: `requireRole(["citizen", "admin"])`
- **Request Body**:
  ```json
  {
    "victimId": "uuid-citizen",
    "locationLat": "10.7769",
    "locationLon": "106.7009",
    "situationDescription": "Motorbike collision, victim alert and breathing"
  }
  ```
- **Response**: `201 Created`
  ```json
  { "report": { "id": "uuid-report", "status": "PENDING", ... } }
  ```
- **Events Published**: `emergency.reported` (to `CORE_SYSTEM_BUS`)
- **Test Cases**:
  1. `[Happy Path]`: Valid GPS coordinates and report details $\rightarrow$ `201 Created`.
  2. `[Negative]`: Missing GPS coordinates $\rightarrow$ `400 Bad Request`.

---

### 1.7 Generate Presigned S3 Upload URL (Async AI Processing)
- **Route**: `POST /api/v1/write/upload-url`
- **Auth**: `requireRole(["citizen", "admin"])`
- **Request Body**:
  ```json
  {
    "fileType": "image/jpeg",
    "operation": "FACE_SCAN",
    "citizenId": "optional-uuid"
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "jobId": "job-uuid",
    "uploadUrl": "https://s3.amazonaws.com/helpme-avatars/raw-scans/job-uuid.jpg?AWSAccessKeyId=...",
    "s3Key": "raw-scans/job-uuid.jpg",
    "expiresIn": 900
  }
  ```
- **Test Case**: Generates upload URL and pre-creates a DynamoDB `PENDING` scan job entry.

---

## 📖 2. Read Server Endpoints (`http://localhost:8081`)

### 2.1 Health Check
- **Route**: `GET /health` or `GET /read-service/health`
- **Auth**: Public
- **Response**: `200 OK`
  ```json
  { "status": "ok", "service": "read-server" }
  ```

---

### 2.2 Get Own Citizen Profile
- **Route**: `GET /api/v1/read/citizen/profile`
- **Auth**: `requireRole(["citizen"])`
- **Response**: `200 OK`
  ```json
  { "profile": { "id": "uuid", "email": "...", "fullName": "..." } }
  ```
- **Test Case**: Retrieves authenticated citizen profile.

---

### 2.3 Get Own Medical Record
- **Route**: `GET /api/v1/read/citizen/medical-record`
- **Auth**: `requireRole(["citizen"])`
- **Response**: `200 OK`
  ```json
  {
    "record": {
      "bloodGroup": "O+",
      "allergies": ["Penicillin"],
      "backgroundDiseases": ["Type 2 Diabetes"],
      "currentMedications": ["Metformin 500mg"]
    }
  }
  ```
- **Test Case**: Retrieves medical conditions and medications for emergency response prep.

---

### 2.4 Get Registered NFC Hardware Tags
- **Route**: `GET /api/v1/read/citizen/nfc-tags`
- **Auth**: `requireRole(["citizen"])`
- **Response**: `200 OK`
  ```json
  { "tags": [ { "id": "NFC_CARD_12345", "status": "ACTIVE", ... } ] }
  ```
- **Test Case**: Lists citizen's active smart cards/bracelets.

---

### 2.5 Emergency Responder Hardware / Face Scan
- **Route**: `POST /api/v1/read/scan`
- **Auth**: `requireRole(["citizen", "admin"])`
- **Request Body (NFC Mode)**:
  ```json
  {
    "method": "NFC",
    "tagId": "NFC_CARD_12345",
    "hashId": "3c98d02a9e3a9c7b..."
  }
  ```
- **Response**: `200 OK`
  ```json
  {
    "citizen": { "id": "uuid", "fullName": "...", "avatarUrl": "..." },
    "record": { "bloodGroup": "O+", "allergies": [...] },
    "accessGranted": true,
    "expiresIn": 3600
  }
  ```
- **Side Effects**:
  - Verifies HMAC signature on the NFC chip.
  - Grants a 1-hour emergency temporary access session in DynamoDB (`helpme-access-sessions`).
  - Emits `victim.identified` event on `EMERGENCY_BUS`.
- **Test Cases**:
  1. `[Happy Path]`: Valid tag and cryptographic hash signature resolves victim & grants session $\rightarrow$ `200 OK`.
  2. `[Negative]`: Tampered / invalid hash signature rejected with `403 Forbidden`.

---

### 2.6 Re-Access Victim Record (Within 1-Hour Session Window)
- **Route**: `GET /api/v1/read/victim/:victimId`
- **Auth**: `requireRole(["citizen", "admin"])`
- **Response**: `200 OK`
  ```json
  { "citizen": { ... }, "record": { ... } }
  ```
- **Logic**: Validates that responder has an active unexpired emergency session (`responderId#victimId`) in DynamoDB.
- **Test Case**: Blocks unauthorized access without an active session $\rightarrow$ `403 Forbidden`.

---

### 2.7 Poll Async Scan / AI Job Status
- **Route**: `GET /api/v1/read/scan/jobs/:jobId`
- **Auth**: `requireRole(["citizen", "admin"])`
- **Response**: `200 OK`
  ```json
  {
    "job": {
      "job_id": "job-uuid",
      "status": "COMPLETED",
      "result": {
        "matchStatus": "MATCH_FOUND",
        "matchesCount": 3,
        "topMatches": [ ... ]
      }
    }
  }
  ```
- **Test Case**: Querying a non-existent job ID returns `404 Not Found`.

---

## ⚠️ Known Behaviour Gaps (verified 2026-08-20)

Two endpoints do not behave the way this reference otherwise implies. Both are documented in
`test/api-test/README.md` (notes D and E) so tests written against them pass today.

| Area | Documented intent | Actual behaviour |
|---|---|---|
| **Role model** | citizen / staff / admin | `extractRole` (`src/shared/middleware/auth.ts`) returns only `"citizen" \| "admin"`; every group that is not `admin`/`admins` — including `staff` — falls through to `citizen` and passes `requireRole(["citizen"])`. Fail-open by default. |
| **`POST /api/nfc` as admin** | `404` when `citizenId` does not exist | The "Citizen profile not found" check only runs in the `role === "citizen"` branch, so an admin-supplied `citizenId` reaches `prisma.nfcTag.upsert`, violates the foreign key, and returns `500`. |

---

## 📊 Checks executed by `npm run test:api` (39 total)

| # | Endpoint | Method | Suite | Expected | Verified Behavior |
|---|---|---|---|---|---|
| 1 | `/health` | `GET` | Write | `200` | Write service liveness |
| 2 | `/api/v1/write/citizen/profile` | `PUT` | Write | `200` | Citizen demographics & consent update |
| 3 | `/api/v1/write/citizen/profile` | `PUT` | Write | `401` | Unauthenticated write rejection |
| 4 | `/api/v1/write/citizen/medical-record` | `PUT` | Write | `200` | Emergency medical facts update |
| 5 | `/api/v1/write/citizen/face` | `POST` | Write | `400` | Empty face image rejection |
| 6 | `/api/v1/write/nfc` | `POST` | Write | `200` | NFC tag registration & HMAC hash calculation |
| 7 | `/api/v1/write/nfc` | `POST` | Write | `400` | Missing tag serial number validation |
| 8 | `/api/v1/write/emergency/report` | `POST` | Write | `201` | Emergency incident report filing |
| 9 | `/api/v1/write/emergency/report` | `POST` | Write | `400` | Missing GPS coordinates validation |
| 10 | `/api/v1/write/upload-url` | `POST` | Write | `200` | Presigned S3 upload URL creation |
| 11 | `/health` | `GET` | Read | `200` | Read service liveness |
| 12 | `/api/v1/read/citizen/profile` | `GET` | Read | `200` | Citizen profile retrieval |
| 13 | `/api/v1/read/citizen/medical-record` | `GET` | Read | `200` | Citizen medical record retrieval |
| 14 | `/api/v1/read/citizen/nfc-tags` | `GET` | Read | `200` | Registered NFC tags list |
| 15 | `/api/v1/read/scan` | `POST` | Read | `200` | NFC scan signature verification & session grant |
| 16 | `/api/v1/read/scan` | `POST` | Read | `403` | Tampered NFC hash signature rejection |
| 17 | `/api/v1/read/victim/:victimId` | `GET` | Read | `403` | Unauthorized victim record access block |
| 18 | `/api/v1/read/scan/jobs/:jobId` | `GET` | Read | `404` | Non-existent scan job 404 response |
| 19 | `/api/v1/write/citizen/medical-record` | `PUT` | Write | `404` | Medical write for absent citizen row |
| 20 | `/api/v1/read/citizen/medical-record` | `GET` | Read | `200` | Absent record → `{}`, not 404 |
| 21 | `/api/v1/write/nfc` | `POST` | Write | `400` | Admin registration without `citizenId` |
| 22 | `/api/v1/write/nfc` | `POST` | Write | `500` | Admin `citizenId` unvalidated — FK violation (should be 404) |
| 23 | `/api/v1/write/nfc` | `POST` | Write | `200` | Re-registering a tag upserts; `hashIdToBurn` stable |
| 24 | `/api/v1/read/scan` | `POST` | Read | `400` | NFC scan missing `tagId`/`hashId` |
| 25 | `/api/v1/read/scan` | `POST` | Read | `404` | Unknown or inactive tag |
| 26 | `/api/v1/read/scan` | `POST` | Read | `400` | FACE scan without `imageBase64` |
| 27 | `/api/v1/read/scan` | `POST` | Read | `400` | Unsupported method (QR) |
| 28 | `/api/v1/write/emergency/report` | `POST` | Write | `201` | Anonymous report (`victimId: null`) |
| 29 | `/api/v1/read/victim/:victimId` | `GET` | Read | `200` | Active session grants access |
| 30 | `/api/v1/read/victim/:victimId` | `GET` | Read | `403` | Expired session refused |
| 31 | `/api/v1/read/victim/:victimId` | `GET` | Read | `404` | Session valid, victim row absent |
| 32 | `/api/v1/write/citizen/profile` | `PUT` | Registration | `200` | First declaration persists every field |
| 33 | `/api/v1/read/citizen/profile` | `GET` | Registration | `200` | Declared info reads back |
| 34 | `/api/v1/write/citizen/profile` | `PUT` | Registration | `200` | ❌ Partial edit silently grants consent (note F) |
| 35 | `/api/v1/write/citizen/profile` | `PUT` | Registration | `200` | Explicit `consentRegulation:false` stored |
| 36 | `/api/v1/write/citizen/profile` | `PUT` | Registration | `403` | Admin cannot declare citizen info |
| 37 | `/api/v1/write/citizen/profile` | `PUT` | Registration | `200` | `staff` falls through to citizen (fail-open) |
| 38 | `/api/v1/write/citizen/profile` | `PUT` | Registration | `404` | Declaration for non-existent citizen row |
| 39 | `/api/v1/read/citizen/profile` | `GET` | Registration | `404` | Unregistered profile |

Row 34 is the only failing check — it is a deliberate reproduction of the consent defect, not a
flaky test. It turns green the moment `citizen.routes.ts:29-30` stop defaulting to `true`.
