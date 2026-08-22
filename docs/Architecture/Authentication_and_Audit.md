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
3. **`grant-permission-worker`**: Subscribes to `victim.identified` on `EMERGENCY_BUS` and creates a 1-hour temporary access token in `helpme-access-sessions`.
4. **`notification-worker`**: Subscribes to `victim.identified` and dispatches automated email alerts to the citizen's emergency contacts.
