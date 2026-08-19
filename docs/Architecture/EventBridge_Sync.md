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
| **`grant-permission-worker`** | `EMERGENCY_BUS` | Grants time-limited emergency authorization to authorized hospital staff to access full medical history. |
