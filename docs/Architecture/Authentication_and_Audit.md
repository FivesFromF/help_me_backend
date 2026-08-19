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
         ├─── Development / Test Mode Header? ───► Populate req.auth from x-cognito-id / x-role
         │
         └─── Production Bearer JWT Header? ─────► Verify with aws-jwt-verify (CognitoJwtVerifier)
                                                        │
                                                        ├── Valid? ──► Extract sub (userId) & cognito:groups (role)
                                                        │              Populate req.auth
                                                        │              Next()
                                                        │
                                                        └── Invalid? ─► Log warning, Next() (requireRole rejects)
```

### RBAC Enforcement (`requireRole`)

Route handlers enforce role permissions using the `requireRole(["citizen" | "admin"])` middleware:
- Returns `401 Unauthorized` if `req.auth` is missing.
- Returns `403 Forbidden` if `req.auth.role` is not in the allowed list.

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
