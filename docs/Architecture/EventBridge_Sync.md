# EventBridge & Serverless Event Sync

## 📡 Event Buses

1. **`CORE_SYSTEM_BUS`**: Handles lifecycle, profile updates, audit tracking, and system maintenance events.
2. **`EMERGENCY_BUS`**: High-priority bus dedicated to emergency incidents, SOS triggers, responder broadcasts, and temporary access grants.

---

## ⚙️ Event Workers (AWS Lambdas)

| Worker | Trigger Bus | Responsibility |
| :--- | :--- | :--- |
| **`post-confirmation`** | Cognito Trigger | Triggered right after citizen confirms email; automatically creates citizen skeleton row in database. |
| **`audit-worker`** | `CORE_SYSTEM_BUS` | Records compliance actions, medical access events, and authentication changes. |
| **`notification-worker`** | `EMERGENCY_BUS` | Sends emergency alerts via SMS/Email and pushes notifications to emergency contacts. |
| **`grant-permission-worker`** | `EMERGENCY_BUS` | Grants time-limited emergency authorization to authorized responders to access full medical history. |

---

## 🧪 What is verified

`npm run test:api` covers both halves of this diagram: §9 asserts that each route publishes its
documented event **to the documented bus**, and §10 hands those captured events to the real
handlers and asserts the effect — the access session, the audit row, the alert email. The chain
check (scan → `victim.identified` → `grant-permission-worker` → victim record readable) is the
one that proves the buses are wired end to end. See [[Services/API_Reference_and_Tests]].

`victim.identified` must stay on **`EMERGENCY_BUS`**: `grant-permission-worker` and
`notification-worker` subscribe to it there, so publishing it to the system bus would strand
every downstream alert while the scan itself still returned `200`.

The audit worker reads **`AUDIT_TABLE_NAME`** and drops events when it is unset — see
[[Runbooks/Local_Testing]].

The alert email itself is proven separately by `npm run test:notify -- <address>`, which sends one
real message through the configured provider — the automated suite always uses a local sink.
