# Authentication & Platform Audit Architecture

This document details the authentication and audit logging architecture for the HelpMe platform.

---

## 🔐 1. Authentication Architecture

The system has transitioned from an API Gateway Lambda Authorizer to **inline Express middleware (`src/shared/middleware/auth.ts`)**, with ingress managed directly by the Application Load Balancer (ALB).

### Authentication Middleware Flow

```
Incoming HTTP Request
         │
         ├─── OPTIONS / Preflight? ──────────────► Next() [Bypass]
         │
         ├─── Public Path (/health, /signin)? ───► Next() [Allow without auth]
         │
         ├─── SKIP_AUTH && x-cognito-id header? ─► Populate req.auth from x-cognito-id / x-role
         │                                          local/dev only — see the note below
         │
         └─── Production Bearer JWT Header? ─────► Verify with aws-jwt-verify (CognitoJwtVerifier)
                                                        │
                                                        ├── Valid? ──► Extract sub (userId) & cognito:groups (role)
                                                        │              Populate req.auth
                                                        │              Next()
                                                        │
                                                        └── Invalid? ─► Log warning, Next() (requireRole rejects)
```

> **The `x-cognito-id` header path is gated by `SKIP_AUTH`.** It exists so the test suite can
> authenticate without Cognito, and it is inert wherever `SKIP_AUTH` is not `"true"`:
>
> ```ts
> if (SKIP_AUTH && headerId) { req.auth = { userId: headerId, role: extractRole([headerRole ?? ""]) }; return next(); }
> ```
>
> Neither `docker-compose.yaml` nor `infra/` sets `SKIP_AUTH`, so the branch is dead in containers
> and in every deployed environment; `.env` sets it for local development only, and `.env` never
> ships. A forged header therefore falls through to JWT verification and is rejected with `401`.
>
> **This was an open authentication bypass until 2026-08-22.** The gate was missing, so the branch
> ran ahead of JWT verification in every environment: `x-cognito-id` plus `x-role: admin` granted
> full admin with no token and no Cognito. Because `SKIP_AUTH` was read into a constant and never
> tested, setting the variable to `false` did nothing — only the code change closed it.
> `test/api-test/auth_gate_check.ts` is the standing regression check and asserts the `401`. It runs
> standalone because the [[Services/API_Reference_and_Tests|API suite]] authenticates by header and
> therefore forces `SKIP_AUTH=true` for all 63 of its checks — the two cannot share a runner.

### RBAC Enforcement (`requireRole`)

Route handlers enforce role permissions using the `requireRole(["citizen" | "admin"])` middleware:
- Returns `401 Unauthorized` if `req.auth` is missing.
- Returns `403 Forbidden` if `req.auth.role` is not in the allowed list.

> **⚠️ There is no `staff` role at runtime — unknown groups fail open to `citizen`.**
> `extractRole` resolves a Cognito group list to `"citizen" | "admin"` only:
>
> ```ts
> function extractRole(groups: string[]): "citizen" | "admin" {
>   if (groups.some((g) => g.toLowerCase() === "admin" || g.toLowerCase() === "admins")) return "admin";
>   return "citizen";   // every other group — including "staff" — lands here
> }
> ```
>
> A member of a `Staff` group is therefore treated as a citizen and is admitted to every
> `requireRole(["citizen"])` route. This contradicts the three-role model (citizen / staff / admin)
> described in `CLAUDE.md` and implemented in the Flutter app's sign-in flows. Verified 2026-08-20
> — `x-role: staff` on `PUT /api/citizen/profile` returns `200`, not `403`.
> Closing this gap is a product decision (which endpoints staff may reach), not just a code fix.

---

## 🚑 1b. Emergency Access Sessions

Identifying a citizen by NFC, QR or face grants the responder a **12-hour** window on that person's
medical record, stored in Postgres (`access_sessions`, one row per responder/victim pair).

| Status | Meaning |
| :-- | :-- |
| `ACTIVE` | live grant; `hasActiveSession` accepts it while `expires_at` is still ahead |
| `EXPIRED` | the window elapsed |
| `COMPLAINED` | the victim objected - **terminal**, and never re-granted |

`hasActiveSession` checks **status and clock**, so a row that is due to expire but not yet swept
still grants nothing, and it fails closed: a database error denies access rather than allowing it.

### Scan location

Each session also carries `scan_lat` / `scan_lon` — where the responder was when they identified the
citizen. All three methods supply it: NFC and QR from the `/api/scan` body (`lat`/`lon`, or
`latitude`/`longitude`), face from `POST /upload-url`, because the AI worker runs long after the
phone has left the scene and the job record is the only place that knowledge can survive.

Both columns are **nullable and never required**. A denied location permission, a basement, or a
slow fix must not cost a responder the medical record — blocking the golden-hour path over a GPS
reading is the wrong trade. Coordinates are validated (finite, in range) and otherwise dropped, and
a later scan without a fix uses `COALESCE` so it cannot erase a location an earlier scan recorded.

The same coordinates ride in the `victim.identified` event's `metadata`, so the audit trail records
where every identification happened without a second write.

**Expired rows are marked, never deleted.** They are the access history that
`emergency_reports.access_session_id` points at and the evidence of who opened whose file; a purge
would destroy the audit trail rather than tidy it. `expireElapsedSessions()` runs opportunistically
from the grant and admin-read paths, so there is no scheduler.

Grants are written by `read-server/routes/scan.routes.ts` (NFC, QR) and the Python AI worker (face),
both inside the VPC - not by an event worker; see [[Architecture/EventBridge_Sync]].

### Complaints revoke access

`POST /api/v1/access/:sessionId/complain`, victim only. Because the medical record is reachable by
more than one route, a complaint has to close all of them, and each was a separate hole:

- `hasActiveSession` rejects the session, so `/api/victim/:id` refuses;
- the NFC and QR scan branches check first - **`/api/scan` returns the record inline**, so blocking
  re-access alone would let the responder simply rescan the card;
- the AI worker checks before writing a match, completing the job with `matchStatus: ACCESS_REVOKED`;
- `grantAccessSession` refuses to re-grant a complained pair, so a fresh scan cannot reset it.

Complaints surface to operators at `GET /api/v1/admin/complaints` and as the `access.complained`
audit event.

> A 12-hour grant is long, and the complaint is **reactive** - it depends on the citizen noticing
> on their history page ([[Services/API_Reference_and_Tests]]). There is no proactive revocation.

---

## 📝 2. Platform Audit Trail (EventBridge & DynamoDB)

Every critical security event, user state change, and emergency action is captured as an immutable event in the **`helpme-audit-logs`** DynamoDB table via AWS EventBridge and the `audit-worker` Lambda.

### Event Schema in DynamoDB (`helpme-audit-logs`)

```json
{
  "actor_id": "cognito-sub-or-responder-id",
  "timestamp": "2026-08-19T10:21:45.123Z#<uuid>",
  "detail_type": "user.consent_accepted",
  "source": "helpme.backend",
  "target_id": "citizen-uuid",
  "method": "FACE",
  "metadata": {
    "consentVersion": "1.0",
    "distance": 0.12
  },
  "raw": { /* Complete EventBridge detail payload */ }
}
```

---

## 📋 3. Complete Audit Event Catalog

| Event Name | Bus | Trigger Condition | Source |
|---|---|---|---|
| **`user.signed_up`** | `CORE_SYSTEM_BUS` | Cognito `post-confirmation` trigger creates new DB profile | `helpme.cognito` |
| **`user.consent_accepted`** | `CORE_SYSTEM_BUS` | Citizen updates profile with `consentRegulation: true` | `helpme.backend` |
| **`citizen.profile.updated`** | `CORE_SYSTEM_BUS` | Citizen updates general profile fields | `helpme.backend` |
| **`medical_record.updated`** | `CORE_SYSTEM_BUS` | Medical record created or modified | `helpme.backend` |
| **`citizen.face.registered`** | `CORE_SYSTEM_BUS` | Citizen completes face biometric registration | `helpme.backend` |
| **`nfc.registered`** | `CORE_SYSTEM_BUS` | NFC tag registered and linked to citizen | `helpme.backend` |
| **`emergency.reported`** | `CORE_SYSTEM_BUS` | Citizen or Admin files an emergency report | `helpme.backend` |
| **`victim.identified`** | `EMERGENCY_BUS` | Face/NFC scan matches victim; triggers session grant & email alert | `helpme.ai-service` / `helpme.backend` |
| **`victim.record.accessed`** | `CORE_SYSTEM_BUS` | Responder re-accesses medical record within 1-hour session | `helpme.backend` |

---

## ⚡ 4. Lambda Triggers

1. **`post-confirmation`**: Auto-assigns new users to the `Citizens` Cognito group and inserts an initial record into PostgreSQL `citizens` table, then emits `user.signed_up`.
2. **`audit-worker`**: Subscribes to `CORE_SYSTEM_BUS` and `EMERGENCY_BUS` and persists every event to `helpme-audit-logs`.
3. **`notification-worker`**: Subscribes to `victim.identified` and dispatches automated email alerts to the citizen's emergency contacts.

> `grant-permission-worker` used to sit in this list, creating the access session from
> `victim.identified`. It was deleted on 2026-08-22: sessions live in Postgres, the scan route and
> the AI worker write them synchronously, and no Lambda is involved in granting any more.
