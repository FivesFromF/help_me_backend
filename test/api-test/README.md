# HelpMe API Test Cases

API-level test cases only — HTTP request in, status + body out. Worker, AI-model and
infrastructure behaviour is out of scope here.

Run: `npm run test:api` (in-process Express apps on ephemeral ports).

**53 of these cases execute today**; 52 pass and R-03 fails against a real defect (note F).
Everything still unimplemented is blocked on the AI service — the face-recognition happy paths
(W-04, W-06, CW-06, and the `method: "FACE"` branch of S-01) need the Python pipeline running.

Every run overwrites `docs/Testing/Test_Report.md` with the result: totals per suite, the failures
with their detail lines, and the full check list.

### Prerequisites

| Needs | Cases | How |
| :-- | :-- | :-- |
| Postgres + pgvector | all | `docker compose up -d db` |
| DynamoDB on `:8001` | W-03, S-07, V-01–V-04 | `docker compose up -d dynamodb dynamodb-init` |
| AI service | W-04, W-06, CW-06, S-01 (FACE) | `cd src/services/ai-server && python main.py` |
| Nothing extra | EV-01–EV-07 | the suite supplies its own event sink on `:4610` |
| DynamoDB on `:8001` | WK-01–WK-04, WK-07 | the workers' own tables — same compose services |
| Nothing extra | WK-05, WK-06 | the suite supplies its own SMTP sink on `:2525` |

The victim-access and job-polling cases need real DynamoDB tables. Both come from
`docker-compose.yaml`, same as Postgres:

```bash
docker compose up -d db dynamodb dynamodb-init
```

`dynamodb` is DynamoDB Local on `:8001`, backed by the `dynamodb_data` volume so tables survive a
restart. `dynamodb-init` creates `helpme-access-sessions` (PK `session_id`), `helpme-scan-jobs`
(PK `job_id`) and `helpme-audit-logs` (PK `actor_id`, SK `timestamp`), then exits — it is
idempotent, so it is safe on every `up`. Set `DYNAMODB_ENDPOINT="http://localhost:8001"` in `.env`
for the in-process suite (the containerised servers get `http://dynamodb:8000` from compose).

Skip this and those cases fail with `ECONNREFUSED 127.0.0.1:8001` — except **V-01, which still
passes for the wrong reason**, because `hasActiveSession()` denies on any DynamoDB error. It is
V-02 and V-03 together that prove authorization actually works.

## Conventions

- **Auth (local):** `SKIP_AUTH=true` lets tests authenticate with headers instead of a Cognito JWT:
  `x-cognito-id: <cognitoId>` and `x-role: citizen | staff | admin`.
  Missing/invalid identity → **401**. Valid identity, wrong role → **403**.
- **Path aliases:** every route below is also registered under `/api/v1/<service>/…` and
  `/api/v1/…`. These cases use the short `/api/…` form.
- **Seeding:** the runner creates a citizen row via Prisma before the suite, and deletes it
  (plus NFC tags, medical records, emergency reports) afterwards.

---

## 1. Registration workflow

The original workflow this file described, corrected against the implementation.

| ID | Step | Method | Path | Role | Expect |
| :-- | :-- | :-- | :-- | :-- | :-- |
| W-01 | Register new user | — | *no HTTP route* | — | See note A |
| W-02 | Register health info | PUT | `/api/citizen/medical-record` | citizen | **200** `{ record }` |
| W-03 | Get avatar upload URL | POST | `/api/upload-url` | citizen, admin | **200** `{ jobId, uploadUrl, s3Key, expiresIn }` |
| W-04 | Register face | POST | `/api/citizen/face` | citizen | **200** `{ success, message }` — see note B |
| W-05 | Update user info | PUT | `/api/citizen/profile` | citizen | **200** |
| W-06 | Update face (re-register) | POST | `/api/citizen/face` | citizen | **200**, overwrites `face_embedding` |

**Note A — registration has no API endpoint.** Users are created by the Cognito
`post-confirmation` trigger (`src/functions/post-confirmation`), which adds the user to the
`Citizens` group and inserts the `citizens` row. It cannot be exercised over HTTP, so the suite
seeds the row directly with Prisma.

**Note B — face registration does not return a presigned URL.** `POST /api/citizen/face` takes
`{ imageBase64 }`, extracts the 512-d embedding synchronously, and returns
`{ success, message }`. The presigned upload URL comes from the separate `POST /api/upload-url`
(W-03), which returns a `jobId` for async processing. They are two distinct steps.

**Note C — there is no sign-in audit log.** The post-authentication trigger and the sign-in /
sign-out audit rules were removed in commit `b7d78ab`. Audit entries exist only for the domain
events in §8, so asserting on a "user signed in" record will always fail.

---

## 2. Health

| ID | Method | Path | Expect |
| :-- | :-- | :-- | :-- |
| H-01 | GET | `/health` (write service) | **200** `{ status: "ok" }` |
| H-02 | GET | `/health` (read service) | **200** `{ status: "ok" }` |

## 3. Citizen — write

| ID | Method | Path | Body / condition | Expect |
| :-- | :-- | :-- | :-- | :-- |
| CW-01 | PUT | `/api/citizen/profile` | full profile + `consentRegulation: true` | **200** |
| CW-02 | PUT | `/api/citizen/profile` | no auth headers | **401** |
| CW-03 | PUT | `/api/citizen/profile` | `x-role: staff` | **200** — see note D |
| CW-03b | PUT | `/api/citizen/profile` | `x-role: admin` | **403** (route is citizen-only) |
| CW-04 | PUT | `/api/citizen/medical-record` | `bloodGroup`, `allergies[]`, `backgroundDiseases[]`, `currentMedications[]`, `notes` | **200** `{ record }` |
| CW-05 | PUT | `/api/citizen/medical-record` | citizen row absent | **404** `Citizen profile not found` |
| CW-06 | POST | `/api/citizen/face` | `{ imageBase64 }` | **200** |
| CW-07 | POST | `/api/citizen/face` | body without `imageBase64` | **400** `Missing imageBase64 in request body` |

`allergies`, `backgroundDiseases` and `currentMedications` default to `[]` when omitted, so a
minimal `{}` body is still a valid 200 — assert on the returned `record`, not just the status.

**Note D — there is no `staff` role at runtime.** `extractRole` in
`src/shared/middleware/auth.ts` returns only `"citizen" | "admin"`: anything that is not
`admin`/`admins` falls through to `citizen`. So `x-role: staff` (and any unknown group) is treated
as a citizen and passes `requireRole(["citizen"])` — CW-03 returns **200**, not 403. This is a
fail-open default and disagrees with the three-role model (citizen / staff / admin) used by
`CLAUDE.md` and the Flutter app. Verified 2026-08-20. To assert a real rejection, use
`x-role: admin` against a citizen-only route (CW-03b).

## 3b. Citizen information registration

Implemented in `registration.api.test.ts`. There is no `/user/register` route (note A) — the
Cognito trigger creates the skeleton row and the citizen declares their information through
`PUT /api/citizen/profile`. This suite seeds and tears down its own citizen so the consent cases
start from `consentRegulation: false` regardless of suite order.

| ID | Method | Path | Body / condition | Expect |
| :-- | :-- | :-- | :-- | :-- |
| R-01 | PUT | `/api/citizen/profile` | full first declaration | **200** + every field persisted to the row |
| R-02 | GET | `/api/citizen/profile` | after R-01 | **200**, values match what was declared |
| R-03 | PUT | `/api/citizen/profile` | consent is `false`, body sets only `phone` | **200** with consent still `false` — **fails today, see note F** |
| R-04 | PUT | `/api/citizen/profile` | `consentRegulation: false` | **200**, stored as `false` |
| R-05 | PUT | `/api/citizen/profile` | `x-role: admin` | **403** (route is citizen-only) |
| R-06 | PUT | `/api/citizen/profile` | `x-role: staff` | **200** — fail-open, see note D |
| R-07 | PUT | `/api/citizen/profile` | `x-cognito-id` with no citizen row | **404** `Profile not found` |
| R-08 | GET | `/api/citizen/profile` | `x-cognito-id` with no citizen row | **404** `Profile not found` |

R-01 asserts against the database row rather than the echoed response, because the handler returns
the Prisma result directly — asserting on the response alone would not catch a field that was
dropped before the write.

**Note F — any profile edit silently grants consent.** `src/services/write-server/routes/citizen.routes.ts:30`
writes `consentRegulation: body.consentRegulation ?? true`, so a request that never mentions
consent — a phone-number correction, say — flips a previously withdrawn `false` back to `true`.
Line 29 does the same for `firstDeclareProfile`, so a routine edit also re-marks the profile as a
first declaration. Because consent is the platform's regulatory record (it emits
`user.consent_accepted` to the audit bus), this manufactures consent the citizen never gave.
R-03 is the reproduction and **is expected to fail until the `?? true` defaults become
`?? undefined`**. Verified 2026-08-20.

## 4. Citizen — read

| ID | Method | Path | Condition | Expect |
| :-- | :-- | :-- | :-- | :-- |
| CR-01 | GET | `/api/citizen/profile` | seeded citizen | **200** `{ profile }` |
| CR-02 | GET | `/api/citizen/profile` | unknown `x-cognito-id` | **404** `Profile not found` |
| CR-03 | GET | `/api/citizen/medical-record` | record exists | **200** `{ record }` |
| CR-04 | GET | `/api/citizen/medical-record` | citizen exists, no record | **200** `{ record: {} }` |
| CR-05 | GET | `/api/citizen/nfc-tags` | — | **200** `{ tags: [...] }` |

CR-04 is the easy one to get wrong: a missing *record* is **200 with an empty object**, not 404.
Only a missing *citizen* is 404.

## 5. NFC

| ID | Method | Path | Body / condition | Expect |
| :-- | :-- | :-- | :-- | :-- |
| N-01 | POST | `/api/nfc` | `{ tagId, name }` as citizen | **200** `{ tagId, hashId }` |
| N-02 | POST | `/api/nfc` | body without `tagId` | **400** `Missing tagId (serial number)` |
| N-03 | POST | `/api/nfc` | admin without `citizenId` | **400** `Missing citizenId` |
| N-04 | POST | `/api/nfc` | admin, `citizenId` not in DB | **500** — see note E (should be 404) |
| N-05 | POST | `/api/nfc` | already-registered `tagId` | **200**, re-registers rather than duplicating |

**Note E — an admin-supplied `citizenId` is never validated.** The `Citizen profile not found`
404 lives inside the `role === "citizen"` branch only (`src/services/write-server/routes/nfc.routes.ts`).
When an admin posts a `citizenId` that does not exist, the handler goes straight to
`prisma.nfcTag.upsert`, violates the foreign key, and returns **500** with a
`PrismaClientKnownRequestError`. N-04 documents the behaviour as it is; a 404 would be correct.
Verified 2026-08-20.

## 6. Scan

| ID | Method | Path | Body / condition | Expect |
| :-- | :-- | :-- | :-- | :-- |
| S-01 | POST | `/api/scan` | `{ method: "NFC", tagId, hashId }`, valid HMAC | **200** victim + medical record |
| S-02 | POST | `/api/scan` | tampered `hashId` | **403** `Invalid hash signature` |
| S-03 | POST | `/api/scan` | NFC without `tagId` / `hashId` | **400** |
| S-04 | POST | `/api/scan` | unknown or inactive tag | **404** `Tag not found or inactive` |
| S-05 | POST | `/api/scan` | `{ method: "FACE" }` without `imageBase64` | **400** |
| S-06 | POST | `/api/scan` | `{ method: "QR" }` | **400** `Unsupported scan method` |
| S-07 | GET | `/api/scan/jobs/:jobId` | unknown job id | **404** `Job not found` |

## 7. Victim access

| ID | Method | Path | Condition | Expect |
| :-- | :-- | :-- | :-- | :-- |
| V-01 | GET | `/api/victim/:victimId` | no active session | **403** |
| V-02 | GET | `/api/victim/:victimId` | active session row present | **200** `{ citizen, record }` |
| V-03 | GET | `/api/victim/:victimId` | session row expired (`expires_at` in the past) | **403** |
| V-04 | GET | `/api/victim/:victimId` | active session, victim not in DB | **404** |

**V-01 needs care.** `hasActiveSession` denies on *any* DynamoDB error, so if the
`access-sessions` table is missing, V-01 passes for the wrong reason. Pair it with V-02 and V-03 —
only the trio proves authorization actually works. A successful S-01 is what grants the session
V-02 depends on.

## 8. Emergency

| ID | Method | Path | Body / condition | Expect |
| :-- | :-- | :-- | :-- | :-- |
| E-01 | POST | `/api/emergency/report` | `{ locationLat, locationLon, situationDescription, victimId? }` | **201** `{ report }` |
| E-02 | POST | `/api/emergency/report` | missing `locationLat` or `locationLon` | **400** `Missing location coordinates` |

`victimId` is optional — an anonymous report (`victimId: null`) is still a valid 201.

## 9. Events emitted

Publishing is best-effort: a failed publish is logged and never changes the HTTP status, so these
cannot be asserted from the response alone. The suite therefore stands up its own EventBridge sink
(`event_capture.ts`) on `:4610` and repoints `EVENTBRIDGE_ENDPOINT` at it, so **no emulator and no
`:4010` listener is required** — and a `local-infra` stack already holding `:4010` does not clash.
Every publish is awaited inside its handler, so the event is recorded before the response resolves.

| ID | Endpoint | Event | Bus | Also asserts |
| :-- | :-- | :-- | :-- | :-- |
| EV-01 | PUT `/api/citizen/profile` | `citizen.profile.updated` | system | `actorId` is the caller |
| EV-02 | PUT `/api/citizen/profile` (consent) | `user.consent_accepted` | system | — |
| EV-03 | PUT `/api/citizen/medical-record` | `medical_record.updated` | system | — |
| EV-04 | POST `/api/nfc` | `nfc.registered` | system | — |
| EV-05 | POST `/api/emergency/report` | `emergency.reported` | system | — |
| EV-06 | POST `/api/scan` (success) | `victim.identified` | **emergency** | victim is the target |
| EV-07 | GET `/api/victim/:victimId` (granted) | `victim.record.accessed` | system | responder is the actor |

EV-06 asserts the bus, not just the event: `grant-permission-worker` and `notification-worker` both
subscribe to `victim.identified` on `helpme-emergency-bus`, so publishing it to the system bus would
strand every downstream alert while the scan itself still returned `200`.

Not yet asserted: `citizen.face.registered` (POST `/api/citizen/face`), which needs the AI service.

## 10. Status code summary

| Code | Meaning in this API |
| :-- | :-- |
| 200 | Success (note: medical record absent → `{ record: {} }`) |
| 201 | Emergency report created — the only 201 |
| 400 | Missing or invalid field in the body |
| 401 | No or invalid authentication |
| 403 | Wrong role, bad hash signature, or no active access session |
| 404 | Citizen / tag / job / victim not found |
| 500 | Unhandled error (AI service down, DB unreachable) |

## 11. Worker effects (§10 in the runner output)

§9 proves the API *published* an event. These take that captured event, hand it to the real
handler from `src/functions/`, and assert the side effect. The handlers are invoked directly
rather than through the `:4010` emulator: that keeps the checks deterministic instead of polling
for a Lambda that may never fire, and it is the same handler code Terraform deploys.

| ID | Worker | Given | Then |
| :-- | :-- | :-- | :-- |
| WK-01 | `grant-permission-worker` | `victim.identified` from a real scan | session row `responder#victim`, TTL ≈ 1h |
| WK-02 | *(chain)* | the session WK-01 wrote | `GET /api/victim/:id` flips **403 → 200** |
| WK-03 | `audit-worker` | `victim.record.accessed` | row in `helpme-audit-logs` under the actor |
| WK-04 | `audit-worker` | event with no `actorId` | row filed under actor `system` |
| WK-05 | `notification-worker` | victim with an emergency contact | alert email to that contact |
| WK-06 | `notification-worker` | victim id that does not exist | nothing sent |
| WK-07 | `grant-permission-worker` | event with no victim | no session written |

WK-02 is the end-to-end one: scan → event → worker → the responder can read the record. Remove the
worker call and it returns 403, which is what makes the other six worth trusting.

⚠️ **`.env` has no `AUDIT_TABLE_NAME`.** The audit worker drops every event without it
(`[audit] AUDIT_TABLE_NAME not set`), so the suite sets a default of `helpme-audit-logs` for its
own run. Anything running a worker outside the suite needs it in the environment.

⚠️ **These never touch the configured SMTP.** `.env` points `SMTP_HOST` at a real provider;
`smtp_capture.ts` overrides host and port before the handler is imported, so nothing an automated
run does can leave the machine. Keep that ordering if you add cases here.

### Sending a real alert on purpose

`npm run test:api` must stay safe to run anywhere, so the live path is a separate, opt-in script:

```bash
npm run test:notify -- you@example.com
```

It verifies the real SMTP credentials, then drives `notification-worker` against a throwaway
citizen carrying that address as next-of-kin, and deletes the citizen afterwards. There is no
default recipient — an emergency alert reaches a real person, so the address must be given
explicitly. Verified against Gmail on 2026-08-21: credentials accepted, alert delivered.
