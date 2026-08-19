# CQRS Pattern (Command Query Responsibility Segregation)

## 📌 Concept & Motivation

In emergency medical assistance, read latency for patient lookups (allergies, blood type, emergency contacts) must be instantaneous during first response, while write operations (medical updates, permission grants, audit logs) require strict transactional integrity.

To achieve this, the HelpMe system decouples mutations from queries:

```
[ Client Apps ]
    ├── (POST / PUT / DELETE) ──> [ Write Server :8080 ] ──> [ PostgreSQL / Prisma ]
    │                                                               │
    │                                                     (Domain Events)
    │                                                               ↓
    │                                                     [ AWS EventBridge ]
    │                                                               ↓
    │                                                     [ Lambda Workers ]
    │
    └── (GET / Lookup) ─────────> [ Read Server :8081 ]  ──> [ Read Replicas / Cache ]
```

---

## ⚡ Write Path (Commands)

1. **Client Request**: Initiates a write action (e.g. `POST /api/v1/citizens/profile`).
2. **Auth & Validation**: JWT verified using `aws-jwt-verify` against Cognito User Pool.
3. **Transactional Write**: PostgreSQL database updated through Prisma ORM.
4. **Event Dispatch**: Write server emits strongly-typed domain events to `CORE_SYSTEM_BUS` or `EMERGENCY_BUS`.

---

## 🔍 Read Path (Queries)

1. **Emergency Responder Lookup**: Scans NFC tag or QR code (`GET /api/v1/emergency/scan/:token`).
2. **Access Control**: Validates emergency access tokens and permissions.
3. **Optimized Read**: Returns sanitized patient emergency cards with minimal latency.
